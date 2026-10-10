import {it,expect} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {httpRuntime,submitScan,finishedJob} from '../helpers/http.js';
import {compilerInput} from '../../packages/core/src/compiler/input.js';
import {defaultSettings} from '../../packages/core/src/execution/settings.js';
import {manualSource,writeDocument} from '../helpers/fixtures.js';

const paper=(text='Selected condition A.',annotation='User comment.')=>`---\ntype: raw_source\nsource_type: paper\ntitle: Selected paper\nsource: zotero://select/library/items/PAPER123\ncaptured_at: "2026-10-10T01:02:03.000Z"\nannotation: ${JSON.stringify(annotation)}\nprocessing_status: pending\nlifecycle_status: active\n---\n${text}`;
it('captures only inline paper text/comments, replays exactly and compiles Annotation-only input without fetching a PDF',async()=>{
  const f=await httpRuntime();const save=async(relative:string,markdown:string)=>f.request('/v1/captures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:relative,markdown,analysis_profile:'academic'})});
  try{
    const relative='20_Sources/Paper/one.md';expect((await save(relative,paper())).status).toBe(201);expect((await save(relative,paper())).status).toBe(200);
    expect((await (await f.request('/v1/jobs')).json()).total).toBe(0);
    const comments='20_Sources/Paper/comments.md';expect((await save(comments,paper('','我的理解\n保留条件 A。'))).status).toBe(201);
    const {job}=await submitScan(f.request);expect((await finishedJob(f.request,job.id)).status).toBe('succeeded');
    const input=JSON.parse((await compilerInput(f.config.vault_path,comments)).prompt);expect(input.annotation).toBe('我的理解\n保留条件 A。');expect(input.submitted_content.trim()).toBe('');
    expect((await (await f.request(`/v1/documents?path=${relative}`)).json()).metadata.analysis_profile).toBe('academic');
    for(const markdown of [paper('',''),paper().replace('zotero://select/library/items/PAPER123','javascript:alert(1)'),paper().replace('zotero://select/library/items/PAPER123','zotero://select/library/items/PAPER123?command=edit'),paper().replace('source_type: paper','source_type: unknown')])expect((await save('20_Sources/Paper/bad.md',markdown)).status).toBe(422);
    const changed=(await readFile(path.join(f.config.vault_path,relative),'utf8'))+'\nUser edit';await writeFile(path.join(f.config.vault_path,relative),changed);
    expect((await save(relative,paper())).status).toBe(409);expect(await readFile(path.join(f.config.vault_path,relative),'utf8')).toBe(changed);
  }finally{await f.cleanup();}
});
it('allows safe new Capture while a full round owns model work, but protects the active target and all other mutations',async()=>{
  let called!:()=>void;const entered=new Promise<void>(resolve=>called=resolve);
  const model=createServer(async(req,res)=>{for await(const _ of req){}called();req.on('close',()=>{});res.on('close',()=>{});});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const f=await httpRuntime(vault=>writeDocument(vault,'20_Sources/active.md',manualSource('Model work.')));
  const post=(route:string,body:unknown)=>f.request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    expect((await post('/v1/compiler/settings',{settings:{...defaultSettings,route:'api',model:'fixture',endpoint:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`}})).status).toBe(200);
    const document=await (await f.request('/v1/documents?path=20_Sources/active.md')).json();const id=randomUUID();
    expect((await post('/v1/processing-rounds',{request_id:id,mode:'selected',items:[{source_path:document.path,source_revision:document.revision}]})).status).toBe(202);await entered;
    const payload={path:'20_Sources/Paper/new.md',markdown:paper()};expect((await post('/v1/captures',payload)).status).toBe(201);
    expect((await post('/v1/captures',payload)).status).toBe(409);expect((await post('/v1/captures',{...payload,path:'20_Sources/active.md'})).status).toBe(409);
    expect((await post('/v1/scans',{mode:'refresh'})).status).toBe(409);expect((await post('/v1/processing/cancel',{id})).status).toBe(200);
    expect((await post('/v1/captures',payload)).status).toBe(200);
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await f.cleanup();}
},20000);
