import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {Value} from '@sinclair/typebox/value';
import {PLANNING_API} from '@engramweave/contracts';
import {humanFixture} from '../helpers/human-review.js';
import {PlannerJobs} from '../../packages/core/src/jobs/planner.js';
import {defaultPlannerSettings} from '../../packages/core/src/planning/settings.js';
import {createHttp} from '../../packages/core/src/http.js';
import {ScanJobs} from '../../packages/core/src/jobs/scans.js';
it('serves authenticated bounded planning and candidate contracts, rejecting stale and cross-workspace saves',async()=>{
  const f=await humanFixture(false);await f.human.submit(await f.request('complete'));
  const planner=new PlannerJobs(f.db,f.config,f.recall,f.human,()=>false,undefined,async(snapshot,tools)=>{
    await tools.call('write_file',{target:'40_Knowledge/result.md',content:`---\nsources: ["[[${snapshot.source.path}]]"]\n---\nSelected knowledge.`,reason:'Integrated'});return{changeset_id:tools.changesetId,summary:'Complete'};
  });await planner.initialize();const jobs=new ScanJobs(f.db,f.config.vault_path);
  const server=createHttp(f.config,{token:'fixture',status:'ready'},()=>({db:f.db,jobs,planner,instance_id:'fixture'}));const headers={host:`127.0.0.1:${f.config.port}`,authorization:'Bearer fixture'};
  try{
    expect((await server.inject({url:'/v1/planner/settings',headers:{...headers,authorization:''}})).statusCode).toBe(401);
    const saved=await server.inject({method:'POST',url:'/v1/planner/settings',headers,payload:{settings:{...defaultPlannerSettings,enabled:true,codex_path:process.execPath}}});expect(saved.statusCode).toBe(200);expect(planner.all()).toEqual([]);
    const payload={request_id:randomUUID(),source_path:f.sourcePath};expect((await server.inject({method:'POST',url:'/v1/plans',headers,payload:{...payload,apply:true}})).statusCode).toBe(400);
    const response=await server.inject({method:'POST',url:'/v1/plans',headers,payload});expect(response.statusCode).toBe(202);expect(Value.Check(PLANNING_API.plan.schema.response[202],response.json())).toBe(true);await planner.wait();
    const id=planner.get(payload.request_id)!.changeset_id!;const manifest=(await planner.changesets.read(id)).manifest;const item=manifest.items[0]!;
    const document=await server.inject({url:`/v1/changeset/candidate?id=${id}&item_id=${item.id}`,headers});expect(document.statusCode).toBe(200);expect(Value.Check(PLANNING_API.candidate.schema.response[200],document.json())).toBe(true);
    const input={request_id:randomUUID(),changeset_id:id,item_id:item.id,revision:document.json().revision,content:'Human final candidate.'};expect((await server.inject({method:'POST',url:'/v1/changeset/candidate',headers,payload:input})).statusCode).toBe(200);
    expect((await server.inject({method:'POST',url:'/v1/changeset/candidate',headers,payload:{...input,content:'Stale overwrite'}})).statusCode).toBe(409);
    expect((await server.inject({url:`/v1/changeset/candidate?id=${randomUUID()}&item_id=${item.id}`,headers})).statusCode).toBe(404);
    expect((await server.inject({url:`/v1/documents?path=${encodeURIComponent(item.candidate_path!)}`,headers})).statusCode).toBe(400);
  }finally{await server.close();await jobs.close();await planner.close();await f.close();}
});
