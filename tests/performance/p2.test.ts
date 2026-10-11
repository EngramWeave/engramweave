import { expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRuntime } from '../helpers/runtime.js';
import { standaloneCore } from '../helpers/cli.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { finishedJob, submitScan } from '../helpers/http.js';

it.skipIf(process.env.ENGRAMWEAVE_F_PERF !== '1')('measures Registry, review and batch latency on authorized third-party Markdown', async () => {
  const f=await isolatedRuntime(); let core: Awaited<ReturnType<typeof standaloneCore>> | undefined;
  const manifest: {path:string;sha256:string;bytes:number}[]=JSON.parse(await readFile('.local/p2-f/corpus-manifest.json','utf8'));
  const timings: Record<string,{samples_ms:number[];p95_ms:number}>={};
  const scans: {label:string;strategy:string|undefined;read_files:number|undefined}[]=[];
  const measured=async<T>(name:string,action:()=>Promise<T>,count=1)=>{let result!:T;const samples:number[]=[];for(let i=0;i<count;i++){const start=performance.now();result=await action();samples.push(performance.now()-start);}const sorted=[...samples].sort((a,b)=>a-b);timings[name]={samples_ms:samples,p95_ms:sorted[Math.ceil(sorted.length*.95)-1]!};return result;};
  try{
    await cp('.local/p2-f/corpus/40_Knowledge',path.join(f.config.vault_path,'40_Knowledge'),{recursive:true});
    for(let i=0;i<216;i++){
      const source=`20_Sources/item-${i%8}.md`;
      if(i<8)await writeDocument(f.config.vault_path,source,manualSource('Original Source body',`processing_status: compiled\nlifecycle_status: active\nannotation: Preserved user context\n`));
      await writeDocument(f.config.vault_path,`30_Drafts/draft-${i}.md`,`---\ntype: draft\ntitle: Candidate ${i}\nlifecycle_status: active\nsources: ["[[${source}]]"]\n---\nUser-edited candidate ${i}.\n`);
    }
    const start=performance.now();core=await standaloneCore(f.root,f.config);timings.startup={samples_ms:[performance.now()-start],p95_ms:performance.now()-start};
    const api=async(route:string,body?:unknown)=>{const response=await core!.request(route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();expect(response.status,JSON.stringify(result)).toBeLessThan(300);return result;};
    for(const [label,mode] of [['first_refresh','refresh'],['repeat_refresh','refresh'],['rebuild','rebuild']] as const)await measured(label,async()=>{const submitted=await submitScan(core!.request,mode);const job=await finishedJob(core!.request,submitted.job.id);expect(job.status).toBe('succeeded');scans.push({label,strategy:job.summary?.scan_strategy,read_files:job.summary?.read_files});return job;});
    await measured('no_change_refresh',async()=>{const job=await finishedJob(core!.request,(await submitScan(core!.request)).job.id);expect(job.status).toBe('succeeded');expect(job.summary).toMatchObject({scan_strategy:'incremental',read_files:0});return job;},10);
    const edited=manifest.filter(item=>item.bytes>2000&&item.bytes<15000).slice(0,3);
    const originals=await Promise.all(edited.map(item=>readFile(path.join(f.config.vault_path,item.path))));
    await writeFile(path.join(f.config.vault_path,edited[0]!.path),Buffer.concat([originals[0]!,Buffer.from('\nChanged for isolated single-file measurement.\n')]));
    await measured('one_changed_refresh',async()=>{const job=await finishedJob(core!.request,(await submitScan(core!.request)).job.id);expect(job.status).toBe('succeeded');expect(job.summary).toMatchObject({scan_strategy:'incremental',read_files:1});scans.push({label:'one_changed_refresh',strategy:job.summary?.scan_strategy,read_files:job.summary?.read_files});return job;});
    await writeFile(path.join(f.config.vault_path,edited[0]!.path),originals[0]!);
    await finishedJob(core!.request,(await submitScan(core!.request)).job.id);
    for(const [index,item] of edited.entries())await writeFile(path.join(f.config.vault_path,item.path),Buffer.concat([originals[index]!,Buffer.from('\nChanged for isolated incremental performance measurement.\n')]));
    await measured('three_changed_refresh',async()=>{const job=await finishedJob(core!.request,(await submitScan(core!.request)).job.id);expect(job.status).toBe('succeeded');expect(job.summary).toMatchObject({scan_strategy:'incremental',read_files:3});scans.push({label:'three_changed_refresh',strategy:job.summary?.scan_strategy,read_files:job.summary?.read_files});return job;});
    for(const [index,item] of edited.entries())await writeFile(path.join(f.config.vault_path,item.path),originals[index]!);
    await finishedJob(core!.request,(await submitScan(core!.request)).job.id);
    await measured('status',()=>api('/v1/status'),10);await measured('sources',()=>api('/v1/sources'),10);
    await measured('search',()=>api('/v1/search?scope=knowledge&q=cache&fields=body'),10);
    await measured('drafts_first',()=>api('/v1/drafts?source_path=20_Sources/item-0.md'));
    await measured('review_first',()=>api('/v1/draft-review?path=30_Drafts/draft-0.md'));
    await measured('review_warm',()=>api('/v1/draft-review?path=30_Drafts/draft-0.md'),5);
    const previews=await measured('preview_8',async()=>{const values=[];for(let i=0;i<8;i++)values.push(await api(`/v1/source-discard-preview?path=20_Sources/item-${i}.md`));return values;});
    await measured('discard_8',async()=>{const batch=await api('/v1/source-batches',{id:randomUUID(),action:'discard',items:previews.map(value=>({...value.source,request_id:randomUUID(),related:value.drafts.map(({path,revision}:{path:string;revision:string})=>({path,revision}))}))});let result;do{await delay(25);result=await api(`/v1/source-batches?id=${batch.id}`);}while(result.status==='running');expect(result.items.every((item:{status:string})=>item.status==='succeeded')).toBe(true);});
    for(const entry of manifest){const bytes=await readFile(path.join(f.config.vault_path,entry.path));expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);}
    await mkdir('.local/p2-f/performance',{recursive:true});await writeFile(`.local/p2-f/performance/${process.env.ENGRAMWEAVE_F_PERF_LABEL??'baseline'}.json`,JSON.stringify({at:new Date().toISOString(),conditions:{markdown:manifest.length,bytes:manifest.reduce((n,x)=>n+x.bytes,0),drafts:216,filesystem:'NTFS',warm_os_cache:true,model_calls:0},timings,scans,unchanged_corpus:true},null,2));
  }finally{await core?.close();await f.cleanup();}
},300000);
