import path from 'node:path';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { integrationFixture } from '../helpers/integration.js';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { createHttp } from '../../packages/core/src/http.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { manualSource } from '../helpers/fixtures.js';

const plan = async (snapshot: { source: {path:string} }, tools: { call(name:string,args:Record<string,unknown>):Promise<unknown>; changesetId:string }) => {
  await tools.call('read_note', { path: '40_Knowledge/library.md' });
  await tools.call('propose_structure', { kind: 'directory', target: '40_Knowledge/NewDomain', reason: 'Group independently useful methods' });
  await tools.call('write_file', { target: '40_Knowledge/NewDomain/method.md', content: `---\nsources: ["[[${snapshot.source.path}]]"]\n---\nUseful method.`, reason: 'Integrate' });
  await tools.call('write_file', { target: '40_Knowledge/Other.md', content: `---\nsources: ["[[${snapshot.source.path}]]"]\n---\nAnother method.`, reason: 'Separate concept' });
  await tools.call('propose_structure', { kind: 'discard', target: '40_Knowledge/library.md', reason: 'Replaced by method' });
  return { changeset_id: tools.changesetId, summary: 'Unified reorganization' };
};
it('persists choices, requires explicit domain grants and accepted parents, and validates only accepted content', async () => {
  const f = await integrationFixture(plan);
  try {
    const manifest = (await f.planner.changesets.read(f.id)).manifest;
    const directory = manifest.items.find(item => item.kind === 'directory')!; const other = manifest.items.find(item => item.target.endsWith('Other.md'))!;
    const document = await f.planner.changesets.candidate(f.id, other.id);
    await f.planner.changesets.save({ request_id: randomUUID(), changeset_id: f.id, item_id: other.id, revision: document.revision, content: '---\nsources: [unclosed\n---\nBroken rejected content.' });
    const accepted = manifest.items.filter(item => item.id !== other.id).map(item => item.id);
    const review = await f.choose(accepted, false);
    await expect(f.execution.approve(await f.approval())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(f.execution.reviews.save({ ...review, revision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await f.choose(accepted.filter(id => id !== directory.id));
    await expect(f.execution.approve(await f.approval())).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    await f.choose(accepted); expect((await f.execution.reviews.read(f.id)).decisions.filter(item => item.decision === 'reject')).toHaveLength(1);
    const result = await f.execution.approve(await f.approval()); expect(result.job.status).toBe('succeeded');
    expect(await readFile(path.join(f.config.vault_path, '40_Knowledge/library.md'), 'utf8')).toContain('lifecycle_status: discarded');
    expect(await readFile(path.join(f.config.vault_path, '40_Knowledge/NewDomain/method.md'), 'utf8')).toContain('Useful method');
    await expect(access(path.join(f.config.vault_path, '40_Knowledge/Other.md'))).rejects.toThrow();
  } finally { await f.close(); }
});
it('rejects all-reject approvals and definite links to rejected proposed files, without banning existing unresolved links', async () => {
  const f = await integrationFixture(plan);
  try {
    await f.choose([]); const request = await f.approval(); await expect(f.execution.approve(request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const manifest = (await f.planner.changesets.read(f.id)).manifest; const method = manifest.items.find(item => item.target.endsWith('method.md'))!;
    let document = await f.planner.changesets.candidate(f.id, method.id);
    await f.planner.changesets.save({ request_id: randomUUID(), changeset_id: f.id, item_id: method.id, revision: document.revision, content: document.content + '\n[[40_Knowledge/Other.md]]' });
    await f.choose(manifest.items.filter(item => !item.target.endsWith('Other.md')).map(item => item.id));
    await expect(f.execution.approve(await f.approval())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    document = await f.planner.changesets.candidate(f.id, method.id);
    await f.planner.changesets.save({ request_id: randomUUID(), changeset_id: f.id, item_id: method.id, revision: document.revision, content: document.content.replace('[[40_Knowledge/Other.md]]', '[[Unresolved personal concept]]') });
    expect((await f.execution.approve(await f.approval())).job.status).toBe('succeeded');
  } finally { await f.close(); }
});
it('preflights read-only targets before any directory or content write', async () => {
  const f = await integrationFixture(plan); const filename = path.join(f.config.vault_path, '40_Knowledge/library.md');
  try {
    await f.choose(); const request = await f.approval(); await chmod(filename, 0o444);
    await expect(f.execution.approve(request)).rejects.toThrow();
    expect((await f.execution.lookup(request.request_id)).job).toBeNull();
    await expect(access(path.join(f.config.vault_path, '40_Knowledge/NewDomain'))).rejects.toThrow();
    expect((await readMarkdown(f.config.vault_path, f.sourcePath)).bytes.toString()).toContain('processing_status: planned');
  } finally { await chmod(filename, 0o666); await f.close(); }
});
it('recovers a partially written multi-file plan and refuses to include new related Drafts silently', async () => {
  const f = await integrationFixture(plan); const original = PropertyNative.prototype.run;
  const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this:PropertyNative,...args) {
    if (args[1] === '40_Knowledge/Other.md' && !args[10]) throw new CoreError('IO_ERROR', 'Injected second-file failure'); return original.apply(this,args);
  });
  try {
    await f.choose(); const request = await f.approval(); expect((await f.execution.approve(request)).job.status).toBe('failed');
    const method = path.join(f.config.vault_path, '40_Knowledge/NewDomain/method.md'); const later = (await readFile(method,'utf8'))+'\nLater edit.'; await writeFile(method,later);
    const unexpected = path.join(f.config.vault_path, '30_Drafts/new.md'); await writeFile(unexpected, (await readMarkdown(f.config.vault_path,f.draftPath)).bytes);
    mock.mockRestore(); expect((await f.execution.approve(request)).job.error?.code).toBe('SOURCE_CHANGED');
    await writeFile(unexpected,(await readFile(unexpected,'utf8')).replace('lifecycle_status: active','lifecycle_status: discarded'));
    expect((await f.execution.approve(request)).job.status).toBe('succeeded'); expect(await readFile(method,'utf8')).toBe(later);
    expect((await f.execution.approve(request)).reused).toBe(true); await expect(f.execution.approve({...request, source_revision:'a'.repeat(64)})).rejects.toMatchObject({code:'PATH_CONFLICT'});
  } finally { mock.mockRestore(); await f.close(); }
});
it('serves execution contracts, exposes partial results and permits unrelated Capture while blocking mutations', async () => {
  const f = await integrationFixture(); const original = PropertyNative.prototype.run;
  const mock = vi.spyOn(PropertyNative.prototype,'run').mockImplementation(function(this:PropertyNative,...args) {if(args[1]===f.sourcePath&&!args[10]&&!args[6]) throw new CoreError('IO_ERROR','Injected archive failure');return original.apply(this,args);});
  const jobs = new ScanJobs(f.db, f.config.vault_path); const server = createHttp(f.config,{token:'fixture',status:'ready'},()=>({db:f.db,jobs,planner:f.planner,integration:f.execution,humanReview:f.human,instance_id:'fixture'}));
  const headers={host:`127.0.0.1:${f.config.port}`,authorization:'Bearer fixture'};
  try {
    await f.choose(); const request=await f.approval();
    const response=await server.inject({method:'POST',url:'/v1/changeset/approve',headers,payload:request});expect(response.statusCode).toBe(200);expect(response.json().job.status).toBe('failed');
    expect((await server.inject({url:`/v1/integration?id=${request.request_id}`,headers})).json().job.completed_paths).toEqual(['40_Knowledge/Integrated.md']);
    expect((await server.inject({method:'POST',url:'/v1/changeset/cancel',headers,payload:{id:f.id}})).statusCode).toBe(409);
    const capture=await server.inject({method:'POST',url:'/v1/captures',headers,payload:{path:'20_Sources/unrelated.md',markdown:manualSource('Unrelated capture.')}});expect(capture.statusCode).toBe(201);
    mock.mockRestore(); expect((await server.inject({method:'POST',url:'/v1/changeset/approve',headers,payload:request})).json().job.status).toBe('succeeded');
    expect((await server.inject({url:'/v1/jobs',headers})).json().items.some((job:{kind:string})=>job.kind==='apply_integration')).toBe(true);
  } finally {mock.mockRestore();await server.close();await jobs.close();await f.close();}
});
