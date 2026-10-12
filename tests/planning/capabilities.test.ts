import {expect,it} from 'vitest';
import {humanFixture} from '../helpers/human-review.js';
import {PlannerSettingsStore,defaultPlannerSettings} from '../../packages/core/src/planning/settings.js';
import {planningInput} from '../../packages/core/src/planning/input.js';
import {PlanningTools} from '../../packages/core/src/planning/tools.js';
import {ChangeSets} from '../../packages/core/src/changesets/store.js';
import {readFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
it('requires delivered evidence, full current reads and explicit new directories, without touching formal content',async()=>{
  const f=await humanFixture(false);
  try{
    await f.human.submit(await f.request('complete'));const settings=new PlannerSettingsStore(f.config);await settings.initialize();await settings.save({...defaultPlannerSettings,enabled:true,codex_path:process.execPath});
    const snapshot=await planningInput(f.config,f.sourcePath,f.human,settings);const store=new ChangeSets(f.config);
    const manifest=await store.create({source_path:f.sourcePath,source_revision:snapshot.source.revision,draft_path:f.draftPath,draft_revision:snapshot.draft.revision,intent:'',model:'test'});
    const tools=new PlanningTools(snapshot,manifest.id,f.config,store,f.recall,AbortSignal.timeout(30000));const original=await readFile(path.join(f.config.vault_path,f.libraryPath),'utf8');
    const content=`---\nsources: ["[[${f.sourcePath}]]"]\n---\nUseful understanding.`;
    await expect(tools.call('write_file',{target:f.libraryPath,content,reason:'Replace without reading'})).rejects.toMatchObject({code:'INVALID_MODEL_OUTPUT'});
    await tools.call('read_note',{path:f.libraryPath});await appendFile(path.join(f.config.vault_path,f.libraryPath),'\nConcurrent edit.');
    await expect(tools.call('read_note',{path:f.libraryPath})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    await expect(tools.call('write_file',{target:'40_Knowledge/new.md',content,reason:'Invented evidence',evidence:[{path:'40_Knowledge/unread.md',revision:'a'.repeat(64),start_line:1,end_line:2}]})).rejects.toMatchObject({code:'INVALID_MODEL_OUTPUT'});
    const proposal=await tools.call('write_file',{target:'50_Research/Topic/Evidence/result.md',content,reason:'Useful research'}) as {item:{id:string};revision:string};
    await expect(store.publish(manifest.id)).rejects.toMatchObject({code:'INVALID_MODEL_OUTPUT'});
    expect(await tools.call('validate_changeset',{})).toMatchObject({valid:false,diagnostics:[{message:expect.stringContaining('directory')}]});
    await tools.call('propose_structure',{kind:'directory',target:'50_Research/Topic',reason:'New research topic'});await tools.call('propose_structure',{kind:'directory',target:'50_Research/Topic/Evidence',reason:'Evidence grouping'});
    await expect(tools.call('edit_file',{target:'50_Research/Topic/Evidence/result.md',revision:'b'.repeat(64),find:'Useful',replace:'Updated',reason:'Stale edit'})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    const candidate=await store.candidate(manifest.id,proposal.item.id);await tools.call('edit_file',{target:candidate.item.target,revision:candidate.revision,find:'Useful',replace:'Updated',reason:'Exact edit'});
    const ready=await store.publish(manifest.id);expect(ready.items.find(i=>i.target==='50_Research/Topic')?.requires_domain_approval).toBe(true);
    expect(await tools.call('validate_changeset',{})).toMatchObject({valid:true,diagnostics:[],formal_files_applied:false});
    expect(ready.items.find(i=>i.target==='50_Research/Topic/Evidence')?.requires_domain_approval).toBe(false);
    await expect(tools.call('apply',{})).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect(await readFile(path.join(f.config.vault_path,f.libraryPath),'utf8')).toBe(original+'\nConcurrent edit.');
  }finally{await f.close();}
});
