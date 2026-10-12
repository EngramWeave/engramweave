import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile,writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { humanFixture } from '../helpers/human-review.js';
import { PlannerJobs, type PlannerExecutor } from '../../packages/core/src/jobs/planner.js';
import { HumanReviewActions } from '../../packages/core/src/review/human.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { defaultPlannerSettings } from '../../packages/core/src/planning/settings.js';
import { analysisToolBridge } from '../../packages/core/src/analysis/tools.js';

describe('Reviewed integration planning and preserved human authority',()=>{
  it('freezes the selected Draft/Intent, uses tools, and preserves selection after planned restart',async()=>{
    const f=await humanFixture(false);let planner:PlannerJobs|undefined;
    try{
      const human=new HumanReviewActions(f.config,f.db,()=>false,async()=>false,source=>planner!.cancelForSource(source));await human.initialize();
      const sibling='30_Drafts/newer.md';await writeFile(path.join(f.config.vault_path,sibling),`---\ntype: draft\ntitle: Newer Draft\nsources: ["[[${f.sourcePath}]]"]\n---\nNewer content that was not selected.`);
      await human.submit(await f.request('complete','Sibling intent',sibling));
      await human.submit(await f.request('complete','Use my selected understanding'));
      const original=await readFile(path.join(f.config.vault_path,f.libraryPath),'utf8');
      const executor:PlannerExecutor=async(snapshot,tools)=>{
        expect(snapshot.draft.path).toBe(f.draftPath);expect(snapshot.draft.content).not.toContain('Newer content');expect(snapshot.intent).toBe('Use my selected understanding');expect(snapshot.relation).toBeNull();
        await tools.call('read_input',{});await tools.call('recall',{q:'condition A'});await tools.call('read_note',{path:f.libraryPath});
        await appendFile(path.join(f.config.vault_path,f.draftPath),'\nLater user edit.');
        const candidate=`---\ntitle: Scope\nsources: ["[[${f.sourcePath}]]"]\n---\nCondition A constrains the effect.\nSelected understanding.\n`;
        await tools.call('write_file',{target:f.libraryPath,content:candidate,reason:'Integrate selected understanding'});
        await expect(tools.call('write_file',{target:f.sourcePath,content:'Overwrite',reason:'Denied'})).rejects.toMatchObject({code:'PATH_OUTSIDE_SCOPE'});
        return{changeset_id:tools.changesetId,summary:'A coherent proposal.'};
      };
      planner=new PlannerJobs(f.db,f.config,f.recall,human,()=>false,undefined,executor);await planner.initialize();
      await planner.settings.save({...defaultPlannerSettings,enabled:true,codex_path:process.execPath,model:'fixture'});
      const request={request_id:randomUUID(),source_path:f.sourcePath};const response=await planner.submit(request);await planner.wait();
      const job=planner.get(response.job.id)!;expect(job.status).toBe('succeeded');expect(job.changeset_id).toBeTruthy();
      expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes.toString()).toContain('processing_status: planned');
      expect(await readFile(path.join(f.config.vault_path,f.libraryPath),'utf8')).toBe(original);
      expect(await readFile(path.join(f.config.vault_path,f.draftPath),'utf8')).toContain('Later user edit.');
      const restarted=new HumanReviewActions(f.config,f.db,()=>false);await restarted.initialize();expect(await restarted.selection(f.sourcePath)).toBe(f.draftPath);
      expect((await restarted.context(f.sourcePath,f.draftPath)).intent).toBe('Use my selected understanding');
      const replay=await planner.submit(request);expect(replay.reused).toBe(true);expect(replay.job.changeset_id).toBe(job.changeset_id);
      await human.submit(await f.request('cancel'));expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes.toString()).toContain('processing_status: compiled');
      expect(await planner.changesets.list(f.sourcePath)).toEqual([]);expect((await human.context(f.sourcePath,f.draftPath)).intent).toBe('Use my selected understanding');
      await restarted.close();await human.close();
    }finally{await planner?.close();await f.close();}
  });
  it('keeps reviewed on model failure and allows a fresh round without recompiling',async()=>{
    const f=await humanFixture(false);let planner:PlannerJobs|undefined;
    try{
      await f.human.submit(await f.request('complete','Preserve intent'));
      planner=new PlannerJobs(f.db,f.config,f.recall,f.human,()=>false,undefined,async()=>{throw new CoreError('INVALID_MODEL_OUTPUT','Invalid integration');});await planner.initialize();
      await planner.settings.save({...defaultPlannerSettings,enabled:true,codex_path:process.execPath});
      for(let round=0;round<2;round++){const response=await planner.submit({request_id:randomUUID(),source_path:f.sourcePath});await planner.wait();expect(planner.get(response.job.id)?.status).toBe('failed');}
      expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes.toString()).toContain('processing_status: reviewed');
      expect(await planner.changesets.list()).toEqual([]);expect((await f.human.context(f.sourcePath,f.draftPath)).intent).toBe('Preserve intent');
    }finally{await planner?.close();await f.close();}
  });
  it('supports bounded candidate payloads above the old analysis bridge limit',async()=>{
    const f=await humanFixture(false);let planner:PlannerJobs|undefined;
    try{
      await f.human.submit(await f.request('complete'));
      planner=new PlannerJobs(f.db,f.config,f.recall,f.human,()=>false,undefined,async(snapshot,tools,signal)=>{
        const bridge=await analysisToolBridge(tools,signal,8*1024*1024);
        try{const result=await fetch(bridge.env.ENGRAMWEAVE_ANALYSIS_URL,{method:'POST',headers:{authorization:`Bearer ${bridge.env.ENGRAMWEAVE_ANALYSIS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({name:'write_file',arguments:{target:'50_Research/result.md',content:`---\nsources: ["[[${snapshot.source.path}]]"]\n---\n${'Context. '.repeat(1500)}`,reason:'Preserve selected research'}})});expect(result.status).toBe(200);}
        finally{await bridge.close();}return{changeset_id:tools.changesetId,summary:'Large bounded research candidate.'};
      });await planner.initialize();await planner.settings.save({...defaultPlannerSettings,enabled:true,codex_path:process.execPath});
      const response=await planner.submit({request_id:randomUUID(),source_path:f.sourcePath});await planner.wait();expect(planner.get(response.job.id)?.status).toBe('succeeded');
    }finally{await planner?.close();await f.close();}
  });
});
