import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { humanFixture } from '../helpers/human-review.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { RecompileActions } from '../../packages/core/src/review/recompile.js';

it('selects B explicitly while retaining A Intent and edits; old receipts never reverse selection or Cancel',async()=>{
 const f=await humanFixture();try{
  const second='30_Drafts/two.md';const bytes=await readFile(path.join(f.config.vault_path,f.draftPath));await writeFile(path.join(f.config.vault_path,second),bytes);
  const a=await f.request('complete','Intent A');await f.human.submit(a);expect((await f.human.context(f.sourcePath,f.draftPath))).toEqual({selected_draft:f.draftPath,intent:'Intent A'});
  await writeFile(path.join(f.config.vault_path,f.draftPath),Buffer.concat([bytes,Buffer.from('\nHuman edit\n')]));expect((await f.human.context(f.sourcePath,f.draftPath)).selected_draft).toBe(f.draftPath);
  await f.human.submit(await f.request('complete','Intent B',second));await f.human.submit(a);
  expect(await f.human.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:second,intent:'Intent A'});
  expect(await f.human.context(f.sourcePath,second)).toEqual({selected_draft:second,intent:'Intent B'});
  await expect(f.human.submit(await f.request('cancel','',f.draftPath))).rejects.toMatchObject({code:'PATH_CONFLICT'});
  await f.human.submit(await f.request('cancel','',second));await f.human.submit(a);
  const restarted=f.create();await restarted.initialize();expect(await restarted.context(f.sourcePath,second)).toEqual({selected_draft:null,intent:'Intent B'});
  expect(parseMarkdown(f.sourcePath,await readFile(path.join(f.config.vault_path,f.sourcePath))).processing_status).toBe('compiled');expect(await readFile(path.join(f.config.vault_path,second))).toEqual(bytes);
 }finally{await f.close();}
});
it('Recompile withdraws selection, retains all Intents and feedback once, and old replay cannot revoke a new Complete',async()=>{
 const f=await humanFixture();try{
  await f.human.submit(await f.request('complete','Keep intent'));
  const req=await f.request('complete');const {action,note,...identity}=req;
  const recompile=new RecompileActions(f.config,f.db,()=>false,(source,id)=>f.human.revoke(source,null,id));await recompile.initialize();
  const input={...identity,feedback:'Feedback'};await recompile.submit(input);expect(await f.human.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:null,intent:'Keep intent'});
  const after=await readFile(path.join(f.config.vault_path,f.sourcePath));await recompile.submit(input);expect(await readFile(path.join(f.config.vault_path,f.sourcePath))).toEqual(after);
  await writeFile(path.join(f.config.vault_path,f.sourcePath),after.toString().replace('processing_status: pending','processing_status: compiled'));
  await f.human.submit(await f.request('complete','Updated intent'));await recompile.submit(input);
  const restarted=f.create();await restarted.initialize();expect(await restarted.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:f.draftPath,intent:'Updated intent'});
 }finally{await f.close();}
});
it('rejects stale revisions, unrelated Drafts, running analysis and out-of-scope paths',async()=>{
 const f=await humanFixture();try{
  const req=await f.request('complete','Intent');await expect(f.human.submit({...req,source_revision:'a'.repeat(64)})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  const {HumanReviewActions}=await import('../../packages/core/src/review/human.js');const busy=new HumanReviewActions(f.config,f.db,()=>true);await expect(busy.submit(req)).rejects.toMatchObject({code:'JOB_BUSY'});
  await expect(f.human.submit({...req,source_path:'40_Knowledge/library.md'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  const other='30_Drafts/other.md';await writeFile(path.join(f.config.vault_path,other),(await readFile(path.join(f.config.vault_path,f.draftPath),'utf8')).replace(f.sourcePath,'20_Sources/other.md'));
  await expect(f.human.submit(await f.request('complete','Intent',other))).rejects.toMatchObject({code:'INVALID_SOURCE'});
 }finally{await f.close();}
});
it('permits manual Complete and Cancel without ever running an Analyzer or changing Draft content',async()=>{
 const f=await humanFixture(false);try{
  const before=await readFile(path.join(f.config.vault_path,f.draftPath));
  expect(f.analyzer.latestForDraft(f.draftPath)).toBeNull();
  await f.human.submit(await f.request('complete','Human-only intent'));
  expect(await f.human.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:f.draftPath,intent:'Human-only intent'});
  expect(parseMarkdown(f.sourcePath,await readFile(path.join(f.config.vault_path,f.sourcePath))).processing_status).toBe('reviewed');
  await f.human.submit(await f.request('cancel'));
  expect(parseMarkdown(f.sourcePath,await readFile(path.join(f.config.vault_path,f.sourcePath))).processing_status).toBe('compiled');
  expect(await readFile(path.join(f.config.vault_path,f.draftPath))).toEqual(before);expect(f.analyzer.all()).toEqual([]);
 }finally{await f.close();}
});
it('does not accept a Review action ID again as Recompile input',async()=>{
 const f=await humanFixture();try{
  const accepted=await f.request('complete','Intent');await f.human.submit(accepted);
  const service=new RecompileActions(f.config,f.db,()=>false,async()=>{},async id=>(await f.human.receipt(id)).status!=='not_found');
  const fresh=await f.request('complete');const {action,note,...identity}=fresh;
  await expect(service.submit({...identity,request_id:accepted.request_id,feedback:'Different route'})).rejects.toMatchObject({code:'PATH_CONFLICT'});
 }finally{await f.close();}
});
