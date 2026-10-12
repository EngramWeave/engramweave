import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {expect,it,vi} from 'vitest';
import {humanFixture} from '../helpers/human-review.js';
import {PlannerJobs,type PlannerExecutor} from '../../packages/core/src/jobs/planner.js';
import {HumanReviewActions} from '../../packages/core/src/review/human.js';
import {defaultPlannerSettings} from '../../packages/core/src/planning/settings.js';
import {CoreError} from '../../packages/core/src/errors.js';

const propose:PlannerExecutor=async(snapshot,tools)=>{await tools.call('write_file',{target:'40_Knowledge/result.md',content:`---\nsources: ["[[${snapshot.source.path}]]"]\n---\nSelected knowledge.`,reason:'Integrate selected material'});return{changeset_id:tools.changesetId,summary:'Complete'};};
it('recovers ready publication and rebuilds the job projection without inference or losing selection',async()=>{
  const f=await humanFixture(false);let planner:PlannerJobs|undefined,restarted:PlannerJobs|undefined;const inference=vi.fn(propose);
  try{
    await f.human.submit(await f.request('complete','Selected intent'));
    planner=new PlannerJobs(f.db,f.config,f.recall,f.human,()=>false,undefined,inference);await planner.initialize();await planner.settings.save({...defaultPlannerSettings,enabled:true,codex_path:process.execPath});
    const publish=planner.changesets.publish.bind(planner.changesets);vi.spyOn(planner.changesets,'publish').mockImplementationOnce(async id=>{await publish(id);throw new CoreError('EXECUTION_FAILED','Interrupted before stage publication');});
    const request={request_id:randomUUID(),source_path:f.sourcePath};await planner.submit(request);await planner.wait();expect(planner.get(request.request_id)?.status).toBe('failed');expect(planner.busy()).toBe(true);
    await planner.close();f.db.exec('DELETE FROM planner_jobs');
    const human=new HumanReviewActions(f.config,f.db,()=>false);await human.initialize();
    restarted=new PlannerJobs(f.db,f.config,f.recall,human,()=>false,undefined,inference);await restarted.initialize();
    expect(restarted.get(request.request_id)?.status).toBe('succeeded');expect(restarted.busy()).toBe(false);expect(inference).toHaveBeenCalledTimes(1);
    expect(await human.selection(f.sourcePath)).toBe(f.draftPath);expect((await human.context(f.sourcePath,f.draftPath)).intent).toBe('Selected intent');
    expect(await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')).toContain('processing_status: planned');
    const id=restarted.get(request.request_id)!.changeset_id!;const item=(await restarted.changesets.read(id)).manifest.items[0]!;
    await unlink(path.join(f.config.vault_path,item.candidate_path!));await restarted.close();
    const missing=new PlannerJobs(f.db,f.config,f.recall,human,()=>false,undefined,inference);await missing.initialize();
    expect(await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')).toContain('processing_status: reviewed');expect(await missing.changesets.list()).toEqual([]);expect(inference).toHaveBeenCalledTimes(1);await missing.close();await human.close();
  }finally{await restarted?.close();await planner?.close();await f.close();}
});
it('allows explicit cancellation of an unresolved publication while preserving subsequent Source edits',async()=>{
  const f=await humanFixture(false);let planner:PlannerJobs|undefined;
  try{
    await f.human.submit(await f.request('complete','Keep intent'));
    planner=new PlannerJobs(f.db,f.config,f.recall,f.human,()=>false,undefined,async(snapshot,tools,signal)=>{
      const result=await propose(snapshot,tools,signal);await writeFile(path.join(f.config.vault_path,f.sourcePath),snapshot.source.content+'\nLater source edit.');return result;
    });await planner.initialize();await planner.settings.save({...defaultPlannerSettings,enabled:true,codex_path:process.execPath});
    const {job}=await planner.submit({request_id:randomUUID(),source_path:f.sourcePath});await planner.wait();expect(planner.get(job.id)?.error?.code).toBe('SOURCE_CHANGED');expect(planner.busy()).toBe(true);
    await planner.cancelChangeSet(planner.get(job.id)!.changeset_id!);expect(planner.busy()).toBe(false);expect(await planner.changesets.list()).toEqual([]);
    expect(await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')).toContain('Later source edit.');expect((await f.human.context(f.sourcePath,f.draftPath)).intent).toBe('Keep intent');
  }finally{await planner?.close();await f.close();}
});
