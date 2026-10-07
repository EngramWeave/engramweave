import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { SourceBatchRequest } from '@engramweave/contracts';
import { compilerFixture, sourceText, waitCompiler } from '../helpers/compiler.js';
import { SourceBatches } from '../../packages/core/src/jobs/source-batches.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';

async function completed(batches: SourceBatches, id: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { const result = batches.get(id); if (result.status !== 'running') return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Batch did not complete');
}
it('runs selected Sources sequentially and applies the single-item Discard and Source-only restore contracts', async () => {
  let calls = 0, concurrent = 0;
  const fixture = await compilerFixture(async () => { expect(++concurrent).toBe(1); calls++; await new Promise(resolve => setTimeout(resolve, 20)); concurrent--; return { title: 'Retained', body: 'Submitted material.' }; });
  const batches = new SourceBatches(fixture.config, fixture.db, fixture.compiler, () => false);
  try {
    const second = '20_Sources/second.md';
    await writeFile(path.join(fixture.config.vault_path, second), sourceText);
    await mkdir(path.join(fixture.config.vault_path, '40_Knowledge'));
    const formal = '---\nsources: ["[[20_Sources/selected.md]]"]\nlifecycle_status: active\n---\nRetain formal knowledge.\n';
    await writeFile(path.join(fixture.config.vault_path, '40_Knowledge/formal.md'), formal);
    const scan = new ScanJobs(fixture.db, fixture.config.vault_path); scan.submit('refresh'); await scan.close();
    const items = await Promise.all([fixture.sourcePath, second].map(async relative => ({ path: relative, revision: (await readMarkdown(fixture.config.vault_path, relative)).revision, request_id: randomUUID() })));
    const request: SourceBatchRequest = { id: randomUUID(), action: 'compile', items };
    await batches.submit(request);
    expect((await completed(batches, request.id)).items.every(item => item.status === 'succeeded')).toBe(true);
    expect(calls).toBe(2);
    expect((await batches.submit(request)).id).toBe(request.id);
    expect(calls).toBe(2);
    const preview = await batches.preview(fixture.sourcePath);
    expect(preview.drafts).toHaveLength(1); expect(preview.references).toHaveLength(1);
    const discard = { id: randomUUID(), action: 'discard' as const, items: [{ ...preview.source, request_id: randomUUID(), related: preview.drafts }] };
    await batches.submit(discard);
    expect((await completed(batches, discard.id)).items[0]?.status).toBe('succeeded');
    const source = await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8');
    expect(source).toContain('processing_status: compiled'); expect(source).toContain('lifecycle_status: discarded');
    expect((await readDraft(fixture.config.vault_path, preview.drafts[0]!.path)).lifecycle_status).toBe('discarded');
    expect(await readFile(path.join(fixture.config.vault_path, '40_Knowledge/formal.md'), 'utf8')).toBe(formal);
    const restore = { id: randomUUID(), action: 'restore' as const, items: [{ path: fixture.sourcePath, revision: (await readMarkdown(fixture.config.vault_path, fixture.sourcePath)).revision, request_id: randomUUID() }] };
    await batches.submit(restore); expect((await completed(batches, restore.id)).items[0]?.status).toBe('succeeded');
    expect((await readDraft(fixture.config.vault_path, preview.drafts[0]!.path)).lifecycle_status).toBe('discarded');
    const changed = { id: randomUUID(), action: 'compile' as const, items: [items[1]!] };
    await batches.submit(changed); expect((await completed(batches, changed.id)).items[0]?.status).toBe('skipped');
    expect(calls).toBe(2);
  } finally { await batches.close(); await fixture.close(); }
});
it('permits a new explicit Compiler request after the old Draft was removed, without replaying the old request', async () => {
  let calls = 0;
  const fixture = await compilerFixture(async () => { calls++; return { title: 'Candidate', body: 'Preserved understanding.' }; });
  try {
    const first = { path: fixture.sourcePath, revision: fixture.revision, request_id: randomUUID() };
    await fixture.compiler.submit(first); const completed = await waitCompiler(fixture.compiler, first.request_id); expect(completed.status).toBe('succeeded');
    await unlink(path.join(fixture.config.vault_path, completed.draft_path!));
    expect((await fixture.compiler.submit(first)).reused).toBe(true);
    expect(calls).toBe(1);
    const next = { path: fixture.sourcePath, revision: (await readMarkdown(fixture.config.vault_path, fixture.sourcePath)).revision, request_id: randomUUID() };
    await fixture.compiler.submit(next); expect((await waitCompiler(fixture.compiler, next.request_id)).status).toBe('succeeded');
    expect(calls).toBe(2);
  } finally { await fixture.close(); }
});
it('marks a retained unfinished batch interrupted at startup without executing its model requests', async () => {
  let calls = 0;
  const fixture = await compilerFixture(async () => { calls++; return { title: 'Wrong', body: 'Must not run on startup' }; });
  const batches = new SourceBatches(fixture.config, fixture.db, fixture.compiler, () => false);
  try {
    const input: SourceBatchRequest = { id: randomUUID(), action: 'compile', items: [{ path: fixture.sourcePath, revision: fixture.revision, request_id: randomUUID() }] };
    await writeFile(path.join(fixture.config.data_dir, 'source-batch.json'), JSON.stringify({ input, result: { id: input.id, action: 'compile', status: 'running', items: [{ path: fixture.sourcePath, status: 'running', job_id: null, error: null }] } }));
    await batches.initialize();
    expect(batches.get(input.id)).toMatchObject({ status: 'interrupted', items: [{ status: 'skipped' }] });
    expect(calls).toBe(0);
    expect(batches.busy()).toBe(false);
  } finally { await batches.close(); await fixture.close(); }
});
