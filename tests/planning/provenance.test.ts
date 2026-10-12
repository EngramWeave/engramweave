import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { integrationFixture } from '../helpers/integration.js';
import { SourceBatches } from '../../packages/core/src/jobs/source-batches.js';
import { CompilerJobs } from '../../packages/core/src/jobs/compiler.js';
import { getDocument } from '../../packages/core/src/storage/registry.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import type { SourceBatchRequest } from '@engramweave/contracts';

it('protects Source references in Ideas and Projects without registering Projects, and marks only explicitly chosen related content', async()=>{
  const f=await integrationFixture(async(snapshot,tools)=>{
    for(const root of ['10_Ideas','60_Projects']){
      await tools.call('propose_structure',{kind:'directory',target:root,reason:'Standard formal root'});
      await tools.call('write_file',{target:`${root}/Linked.md`,content:`---\nlifecycle_status: active\nsources: ["[[${snapshot.source.path}]]"]\n---\nApproved related content.`,reason:'Preserve provenance'});
    }
    return{changeset_id:tools.changesetId,summary:'Linked content'};
  });
  const compiler=new CompilerJobs(f.db,f.config,()=>false);const batches=new SourceBatches(f.config,f.db,compiler,()=>false);
  const run=async(request:SourceBatchRequest)=>{await batches.submit(request);for(let i=0;i<300&&batches.busy();i++)await new Promise(resolve=>setTimeout(resolve,20));return batches.get(request.id);};
  try{
    await f.choose();expect((await f.execution.approve(await f.approval())).job.status).toBe('succeeded');
    expect(getDocument(f.db,'60_Projects/Linked.md')).toBeUndefined();
    const preview=await batches.preview(f.sourcePath);expect(preview.references.map(item=>item.path)).toEqual(['10_Ideas/Linked.md','60_Projects/Linked.md']);
    const projectBefore=await readFile(path.join(f.config.vault_path,'60_Projects/Linked.md'),'utf8');
    const marked=await run({id:randomUUID(),action:'discard',items:[{...preview.source,request_id:randomUUID(),related:preview.references.filter(item=>item.path.startsWith('60_Projects/'))}]});expect(marked.items[0]?.status).toBe('succeeded');
    expect(await readFile(path.join(f.config.vault_path,'60_Projects/Linked.md'),'utf8')).toBe(projectBefore.replace('lifecycle_status: active','lifecycle_status: discarded'));
    const deleted=await run({id:randomUUID(),action:'delete',items:[{path:f.sourcePath,revision:(await readMarkdown(f.config.vault_path,f.sourcePath)).revision,request_id:randomUUID()}]});expect(deleted.items[0]?.status).toBe('skipped');expect(deleted.items[0]?.error?.message).toContain('references');await access(path.join(f.config.vault_path,f.sourcePath));
    const current=await batches.preview(f.sourcePath);expect(current.references.map(item=>item.path)).toEqual(['10_Ideas/Linked.md']);
    const confirmed=await run({id:randomUUID(),action:'delete',items:[{...current.source,request_id:randomUUID(),allow_referenced:true,reference_revisions:current.references}]});expect(confirmed.items[0]?.status).toBe('succeeded');await expect(access(path.join(f.config.vault_path,f.sourcePath))).rejects.toThrow();
    expect(await readFile(path.join(f.config.vault_path,'10_Ideas/Linked.md'),'utf8')).toContain('lifecycle_status: active');
  }finally{await batches.close();await compiler.close();await f.close();}
});
