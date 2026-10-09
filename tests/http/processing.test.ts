import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { API, type ProcessingRound } from '@engramweave/contracts';
import { httpRuntime } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { analysisProfile, emptyAnalysis } from '../helpers/analyzer.js';

it('retries a real HTTP 503 once, does not retry 401, keeps the Draft, and permits explicit Relation-only batch retry', async () => {
  const calls: string[] = []; let compilerCalls = 0; let failReview = true;
  const model = createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); const task = input.response_format.json_schema.name;
    calls.push(task);
    if (task === 'compiler_result' && ++compilerCalls === 1) {res.writeHead(503,{'retry-after':'0'}).end();return;}
    if (task === 'review_result' && failReview) {res.writeHead(401).end();return;}
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:task === 'compiler_result' ? JSON.stringify({title:'Compiled',body:'Condition A is required.'}) : emptyAnalysis(task === 'review_result' ? 'review' : 'relation')}}]}));
  });
  await new Promise<void>(resolve => model.listen(0,'127.0.0.1',resolve));
  const endpoint = `http://127.0.0.1:${(model.address() as {port:number}).port}/v1`;
  const f = await httpRuntime(vault => writeDocument(vault,'20_Sources/new.md',manualSource('Condition A is required.')));
  const post = async (route: string,body: unknown) => {const response = await f.request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const waitRound = async (id: string) => {for (let n=0;n<300;n++) {const r:ProcessingRound = await (await f.request(`/v1/processing-round?id=${id}`)).json();if (!['queued','running'].includes(r.status)) return r;await delay(25);}throw new Error('Round did not finish');};
  try {
    expect((await post('/v1/compiler/settings',{settings:{...defaultSettings,route:'api',endpoint,model:'fixture'}})).status).toBe(200);
    const profile = analysisProfile();for (const task of ['review','relation'] as const) profile[task].execution.endpoint = endpoint;
    expect((await f.request('/v1/analysis/templates')).status).toBe(200);
    expect((await post('/v1/analysis/settings',{settings:{default_profile:'knowledge',profiles:[profile]}})).status).toBe(200);
    const request = {request_id:randomUUID(),mode:'selected',items:[{source_path:'20_Sources/new.md',source_revision:(await (await f.request('/v1/documents?path=20_Sources/new.md')).json()).revision}]};
    const first = await post('/v1/processing-rounds',request); expect(first.status).toBe(202);expect(Value.Check(API.processing.schema.response[202],first.body)).toBe(true);
    expect((await post('/v1/processing-rounds',request)).body.reused).toBe(true);
    const settings=await (await f.request('/v1/processing/settings')).json();expect((await post('/v1/processing/settings',{...settings,enabled:false,max_retries:0})).status).toBe(200);
    expect((await post('/v1/compilations',{request_id:randomUUID(),path:'20_Sources/new.md',revision:request.items[0]!.source_revision})).status).toBe(409);
    const ended = await waitRound(request.request_id); expect(ended.status).toBe('failed');expect(ended.max_retries).toBe(2); expect(calls).toEqual(['compiler_result','compiler_result','review_result','relation_result']);
    const item = ended.items[0]!; const job = await (await f.request(`/v1/jobs/${item.compiler_job_id}`)).json();expect(job.attempts.map((a:{status:string}) => a.status)).toEqual(['failed','succeeded']);
    expect(Value.Check(API.processingRound.schema.response[200],ended)).toBe(true);expect(await readdir(path.join(f.config.vault_path,'30_Drafts'))).toHaveLength(1);
    const review = await (await f.request(`/v1/draft-review?path=${item.draft_path}`)).json();expect(review.source.processing_status).toBe('compiled');
    const original = await readFile(path.join(f.config.vault_path,item.draft_path!));failReview = false;
    const retry = {request_id:randomUUID(),mode:'analyze',items:[{source_path:review.source.path,source_revision:review.source.revision,draft_path:review.draft.path,draft_revision:review.draft.revision,task:'relation'}]};expect((await post('/v1/processing-rounds',retry)).status).toBe(202);expect((await waitRound(retry.request_id)).status).toBe('succeeded');
    expect(calls.at(-1)).toBe('relation_result');expect(calls).toHaveLength(5);expect(await readFile(path.join(f.config.vault_path,item.draft_path!))).toEqual(original);
    const after = await (await f.request(`/v1/draft-review?path=${item.draft_path}`)).json();expect(after.analyses.review.id).toBe(item.analyzer_job_id);expect(after.analyses.relation.id).not.toBe(item.analyzer_job_id);
    const action = {request_id:randomUUID(),source_path:after.source.path,source_revision:after.source.revision,draft_path:after.draft.path,draft_revision:after.draft.revision,feedback:'Please retain condition A.'};expect((await post('/v1/recompile',action)).body.recompile_count).toBe(1);expect((await post('/v1/recompile',action)).body.reused).toBe(true);
    expect((await (await f.request('/v1/sources?view=pending&recompile=recompile')).json()).items).toHaveLength(1);expect((await (await f.request('/v1/sources?view=pending&recompile=first')).json()).items).toHaveLength(0);expect(calls).toHaveLength(5);
  } finally {await f.cleanup();await new Promise<void>((resolve,reject) => model.close(e => e ? reject(e) : resolve()));}
});
