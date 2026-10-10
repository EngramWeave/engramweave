import {it,expect} from 'vitest';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {httpRuntime} from '../helpers/http.js';
import {startCore} from '../../packages/core/dist/main.js';
import {defaultSettings} from '../../packages/core/src/execution/settings.js';
import {analysisProfile} from '../helpers/analyzer.js';
import type {ProcessingRound} from '@engramweave/contracts';

it.skipIf(process.env.ENGRAMWEAVE_E1_LIVE!=='1')('uses actual API models on a paper Capture payload, preserving Source comments and Draft provenance',async()=>{
  const f=await httpRuntime(async vault=>{for(const root of ['20_Sources','30_Drafts','40_Knowledge'])await mkdir(path.join(vault,root),{recursive:true});},startCore);
  const evidence=path.resolve('.local/p2-e1/real',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(evidence,{recursive:true});
  const api=async(route:string,body?:unknown)=>{const r=await f.request(route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw new Error(JSON.stringify(j));return j;};
  try{
    const execution={...defaultSettings,route:'api' as const,endpoint:'http://127.0.0.1:8094/v1',model:'qwen3.8-27b',output_format:'text' as const,reasoning_effort:'none' as const,output_tokens:{parameter:'max_tokens' as const,limit:8192}};
    await api('/v1/compiler/settings',{settings:execution});await api('/v1/analysis/templates');const profile=analysisProfile('output');profile.review.execution=execution;profile.relation.execution=execution;await api('/v1/analysis/settings',{settings:{default_profile:profile.id,profiles:[profile]}});
    const payload={path:`20_Sources/Paper/${randomUUID()}.md`,markdown:`---\ntype: raw_source\nsource_type: paper\ntitle: 文件版本保护\nsource: zotero://select/library/items/PAPER123\ncaptured_at: "${new Date().toISOString()}"\nprocessing_status: pending\nlifecycle_status: active\nanalysis_profile: ${profile.id}\nannotation: "我的理解：缓存和数据库是可重建投影，不能取代文件。"\n---\n### [iv](zotero://open-pdf/library/items/PDF12345?page=4&annotation=ANNO1234)\n\n写入文件之前必须核对内容哈希。遇到并发修改应报告冲突，不能覆盖用户内容。`};
    expect((await api('/v1/captures',payload)).created).toBe(true);expect((await api('/v1/captures',payload)).created).toBe(false);expect((await api('/v1/jobs')).total).toBe(0);
    const initial=await readFile(path.join(f.config.vault_path,payload.path),'utf8');const started=performance.now();const id=randomUUID();await api('/v1/processing-rounds',{request_id:id,mode:'selected',items:[{source_path:payload.path}]});
    let round:ProcessingRound|undefined;for(let n=0;n<600;n++){round=await api(`/v1/processing-round?id=${id}`);if(!['queued','running'].includes(round!.status))break;await delay(500);}
    const item=round!.items[0]!;const result=item.analyzer_job_id?await api(`/v1/analysis/result?id=${item.analyzer_job_id}`):null;
    await writeFile(path.join(evidence,'result.json'),JSON.stringify({round,result,elapsed_ms:performance.now()-started},null,2));expect(round!.status,JSON.stringify(round)).toBe('succeeded');
    const review=await api(`/v1/draft-review?path=${encodeURIComponent(item.draft_path!)}`);expect(review.draft.sources).toContain(payload.path);expect(review.draft.metadata.captured_at).toBe(review.source.captured_at);expect(review.draft.metadata.annotation).toBe(review.source.annotation);
    expect(initial).toContain('我的理解');expect(review.source.source_content).not.toContain('我的理解');expect(review.source.annotation).toContain('我的理解');expect(result.review).not.toBeNull();expect(result.relation).not.toBeNull();
    await writeFile(path.join(evidence,'review.json'),JSON.stringify(review,null,2));
  }finally{await f.cleanup();}
},360000);
