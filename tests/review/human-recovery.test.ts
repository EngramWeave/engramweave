import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { humanFixture } from '../helpers/human-review.js';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { HumanReviewActions } from '../../packages/core/src/review/human.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';
import { SourceBatches } from '../../packages/core/src/jobs/source-batches.js';
import type { CompilerJobs } from '../../packages/core/src/jobs/compiler.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { randomUUID } from 'node:crypto';

it.each([false,true])('recovers accepted Complete or preserves a concurrent Source conflict (conflict=%s)',async conflict=>{
 const f=await humanFixture();const mock=vi.spyOn(PropertyNative.prototype,'run').mockRejectedValue(new CoreError('IO_ERROR','Interrupted native write'));
 try{
  const req=await f.request('complete','Durable intent');await expect(f.human.submit(req)).rejects.toMatchObject({code:'IO_ERROR'});expect((await f.human.receipt(req.request_id)).status).toBe('unfinished');expect(f.human.busy()).toBe(true);
  mock.mockRestore();if(conflict)await writeFile(path.join(f.config.vault_path,f.sourcePath),`${await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')}\nConcurrent edit\n`);
  const recovered=f.create();await recovered.initialize();expect(recovered.busy()).toBe(conflict);
  expect((await recovered.receipt(req.request_id)).status).toBe(conflict?'unfinished':'completed');
  if(!conflict)expect(await recovered.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:f.draftPath,intent:'Durable intent'});
  else expect(await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')).toContain('Concurrent edit');
 }finally{mock.mockRestore();await f.close();}
});
it('keeps accepted Intent and file stage with a fresh empty database projection',async()=>{
 const f=await humanFixture();let rebuilt:Awaited<ReturnType<typeof openDatabase>>|undefined;
 try{
  const request=await f.request('complete','Independent of SQLite');await f.human.submit(request);
  const {mkdir}=await import('node:fs/promises');const directory=path.join(f.root,'fresh-data');await mkdir(directory);
  rebuilt=await openDatabase({...f.config,data_dir:directory});const human=new HumanReviewActions(f.config,rebuilt,()=>false);await human.initialize();
  expect(await human.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:f.draftPath,intent:'Independent of SQLite'});expect((await human.receipt(request.request_id)).status).toBe('completed');
  expect(await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')).toContain('processing_status: reviewed');
 }finally{rebuilt?.close();await f.close();}
});
it('recovers a stage already written when saving the completion receipt fails',async()=>{
 const f=await humanFixture();const service=f.human as unknown as {save(record:{completed:boolean}):Promise<void>};const original=service.save.bind(service);
 const mock=vi.spyOn(service,'save').mockImplementation(record=>{if(record.completed)throw new CoreError('IO_ERROR','Completion interrupted');return original(record);});
 try{
  const request=await f.request('complete','Saved before stage mutation');await expect(f.human.submit(request)).rejects.toMatchObject({code:'IO_ERROR'});
  expect(await readFile(path.join(f.config.vault_path,f.sourcePath),'utf8')).toContain('processing_status: reviewed');mock.mockRestore();
  const restored=f.create();await restored.initialize();expect(restored.busy()).toBe(false);expect(await restored.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:f.draftPath,intent:'Saved before stage mutation'});
 }finally{mock.mockRestore();await f.close();}
});
it('Source Discard and Restore keep the old selection revoked and retain Draft Intent',async()=>{
 const f=await humanFixture();const batches=new SourceBatches(f.config,f.db,{busy:()=>false} as CompilerJobs,()=>false,()=>{},async target=>{
  if(target.startsWith('20_Sources/'))await f.human.revoke(target);else await f.human.revoke(f.sourcePath,target);
 });
 try{
  await f.human.submit(await f.request('complete','Keep while discarded'));const preview=await batches.preview(f.sourcePath);
  await batches.submit({id:randomUUID(),action:'discard',items:[{...preview.source,request_id:randomUUID(),related:preview.drafts}]});
  await vi.waitFor(()=>expect(batches.latest()?.status).toBe('completed'));expect(batches.latest()?.items[0]?.status).toBe('succeeded');
  await batches.submit({id:randomUUID(),action:'restore',items:[{path:f.sourcePath,revision:(await readMarkdown(f.config.vault_path,f.sourcePath)).revision,request_id:randomUUID()}]});
  await vi.waitFor(()=>expect(batches.latest()?.status).toBe('completed'));
  const filename=path.join(f.config.vault_path,f.draftPath);await writeFile(filename,(await readFile(filename,'utf8')).replace('lifecycle_status: discarded','lifecycle_status: active'));
  const restored=f.create();await restored.initialize();expect(await restored.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:null,intent:'Keep while discarded'});
 }finally{await batches.close();await f.close();}
});
it('reconciles discarded selected Draft before Restore, retaining Intent after restart',async()=>{
 const f=await humanFixture();try{
  const req=await f.request('complete','My intent');await f.human.submit(req);
  const filename=path.join(f.config.vault_path,f.draftPath);const original=await readFile(filename,'utf8');await writeFile(filename,original.replace('lifecycle_status: active','lifecycle_status: discarded'));
  const recovered=f.create();await recovered.initialize();await writeFile(filename,original);
  const restored=f.create();await restored.initialize();await restored.submit(req);expect(await restored.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:null,intent:'My intent'});
 }finally{await f.close();}
});
