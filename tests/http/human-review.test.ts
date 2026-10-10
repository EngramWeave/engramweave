import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DraftReviewSchema, HumanReviewResponseSchema, ReviewActionReceiptSchema } from '@engramweave/contracts';
import { humanFixture } from '../helpers/human-review.js';
import { createHttp } from '../../packages/core/src/http.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';

it('serves authenticated human actions, selected Draft / own Intent, and strictly bounded receipts',async()=>{
 const f=await humanFixture(false);const jobs=new ScanJobs(f.db,f.config.vault_path,()=>false);
 const server=createHttp(f.config,{token:'fixture',status:'ready'},()=>({db:f.db,jobs,analyzer:f.analyzer,humanReview:f.human,instance_id:'fixture'}));
 const headers={host:`127.0.0.1:${f.config.port}`,authorization:'Bearer fixture'};
 try{
  const payload=await f.request('complete','Draft-owned intent');
  expect((await server.inject({method:'POST',url:'/v1/human-review',headers:{...headers,authorization:''},payload})).statusCode).toBe(401);
  expect((await server.inject({method:'POST',url:'/v1/human-review',headers:{...headers,origin:'app://obsidian.md'},payload})).statusCode).toBe(403);
  expect((await server.inject({method:'POST',url:'/v1/human-review',headers,payload:{...payload,note:'x'.repeat(8001)}})).statusCode).toBe(400);
  const accepted=await server.inject({method:'POST',url:'/v1/human-review',headers,payload});expect(accepted.statusCode).toBe(200);expect(Value.Check(HumanReviewResponseSchema,accepted.json())).toBe(true);
  const context=await server.inject({method:'GET',url:`/v1/draft-review?path=${encodeURIComponent(f.draftPath)}`,headers});expect(Value.Check(DraftReviewSchema,context.json())).toBe(true);
  expect(context.json().human_review).toEqual({selected_draft:f.draftPath,intent:'Draft-owned intent'});expect(context.json().source.processing_status).toBe('reviewed');
  expect(context.json().analysis).toBeNull();expect(f.analyzer.all()).toEqual([]);
  const receipt=await server.inject({method:'GET',url:`/v1/review-action?id=${payload.request_id}`,headers});expect(Value.Check(ReviewActionReceiptSchema,receipt.json())).toBe(true);expect(receipt.json().request).toEqual(payload);
  const absent=await server.inject({method:'GET',url:`/v1/review-action?id=${randomUUID()}`,headers});expect(absent.json()).toEqual({status:'not_found',request:null,result:null});
  expect((await server.inject({method:'GET',url:'/v1/review-action?id=../secret',headers})).statusCode).toBe(400);
 }finally{await server.close();await jobs.close();await f.close();}
});
