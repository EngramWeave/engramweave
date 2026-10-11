import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { DiscardPreviewSchema, type SourceBatch, type SourceBatchRequest } from '@engramweave/contracts';
import type { Static } from '@sinclair/typebox';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';

const source = '20_Sources/deleted.md';
type DiscardPreview = Static<typeof DiscardPreviewSchema>;
const draft = (name: string, sourcePath = source, life = 'active') => `---\ntype: draft\ntitle: ${name}\nsources: ["[[${sourcePath}]]"]\nlifecycle_status: ${life}\n---\nUser text ${name}.\n`;
const sourceText = manualSource('Retained material', 'processing_status: compiled\n');
async function fixture() {
  return httpRuntime(async vault => {
    await writeDocument(vault, source, sourceText);
    for (const name of ['one', 'two', 'old']) await writeDocument(vault, `30_Drafts/${name}.md`, draft(name, source, name === 'old' ? 'discarded' : 'active'));
    await writeDocument(vault, '40_Knowledge/formal.md', `---\nsources: ["[[${source}]]"]\n---\nFormal content.\n`);
  });
}
type Request = Awaited<ReturnType<typeof fixture>>['request'];
async function preview(request: Request, relative = source): Promise<DiscardPreview> {
  const response = await request('/v1/source-discard-preview?' + new URLSearchParams({ path: relative }));
  expect(response.status).toBe(200);
  return response.json();
}
async function batch(request: Request, action: SourceBatchRequest['action'], items: SourceBatchRequest['items']) {
  const input = { id: randomUUID(), action, items };
  const accepted = await request('/v1/source-batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect(accepted.status, accepted.ok ? '' : JSON.stringify(await accepted.json())).toBe(202);
  for (let attempt = 0; attempt < 1200; attempt++) {
    const result: SourceBatch = await (await request(`/v1/source-batches?id=${input.id}`)).json();
    if (result.status !== 'running') return { input, result };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Batch did not complete');
}
const target = (value: DiscardPreview, related: SourceBatchRequest['items'][number]['related'] = []) => ({ ...value.source, source_missing: value.source_missing === true, request_id: randomUUID(), related: related.map(({path, revision}) => ({path, revision})) });

it('retains missing alerts on Refresh, but Rebuild prunes absent registrations atomically without deleting files or Job history', async () => {
  const runtime = await fixture(); const { config, request } = runtime;
  const db = new Database(path.join(config.data_dir, 'core.sqlite'));
  try {
    await writeDocument(config.vault_path, '20_Sources/still-present.md', sourceText);
    const initial = await submitScan(request); expect((await finishedJob(request, initial.job.id)).status).toBe('succeeded');
    const identity = db.prepare("SELECT id FROM documents WHERE path='20_Sources/still-present.md'").get();
    const formal = await readFile(path.join(config.vault_path, '40_Knowledge/formal.md'));
    await unlink(path.join(config.vault_path, source));
    await finishedJob(request, (await submitScan(request)).job.id);
    const full = await request('/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'refresh', force_full: true }) });
    await finishedJob(request, (await full.json()).job.id);
    expect(await (await request('/v1/sources?view=issues')).json()).toMatchObject({ total: 1, items: [{ path: source, state: 'missing' }] });
    await unlink(path.join(config.vault_path, '40_Knowledge/formal.md'));
    await writeDocument(config.vault_path, '20_Sources/invalid.md', manualSource('Bad properties', 'processing_status: typo\n'));
    const rebuilt = await finishedJob(request, (await submitScan(request, 'rebuild')).job.id);
    expect(rebuilt).toMatchObject({ status: 'succeeded', summary: { removed: 2, source_count: 1, invalid: 1, scan_strategy: 'full' } });
    expect(db.prepare('SELECT path FROM documents ORDER BY path').all()).toEqual([{ path: '20_Sources/invalid.md' }, { path: '20_Sources/still-present.md' }]);
    expect(db.prepare("SELECT id FROM documents WHERE path='20_Sources/still-present.md'").get()).toEqual(identity);
    expect((await request(`/v1/jobs/${initial.job.id}`)).status).toBe(200);
    expect(await (await request('/v1/sources?view=issues')).json()).toMatchObject({ total: 1, items: [{ state: 'invalid' }], views: { all: 2, processing: 1, issues: 1 } });
    expect(await readFile(path.join(config.vault_path, '30_Drafts/one.md'), 'utf8')).toBe(draft('one'));
    expect(formal.toString()).toContain('Formal content');
    const orphan = await preview(request); expect(orphan).toMatchObject({ source: { path: source, revision: null }, source_missing: true });
    expect(orphan.drafts.map(value => value.path)).toEqual(['30_Drafts/one.md', '30_Drafts/two.md']);
    const discarded = await batch(request, 'discard_drafts', [target(orphan, [orphan.drafts[0]!])]);
    expect(discarded.result.items[0]?.status).toBe('succeeded');
    expect(await readFile(path.join(config.vault_path, '30_Drafts/one.md'), 'utf8')).toContain('lifecycle_status: discarded');
    expect(await readFile(path.join(config.vault_path, '30_Drafts/two.md'), 'utf8')).toBe(draft('two'));
  } finally { db.close(); await runtime.cleanup(); }
});

it('discards selected orphan Drafts and cleans only the missing Source row, with idempotent replay and preserved references', async () => {
  const runtime = await fixture(); const { config, request } = runtime;
  try {
    await finishedJob(request, (await submitScan(request)).job.id);
    await unlink(path.join(config.vault_path, source));
    await finishedJob(request, (await submitScan(request)).job.id);
    const value = await preview(request); expect(value.source_missing).toBe(true);
    expect(value.references).toHaveLength(1); expect(value.drafts).toHaveLength(2);
    const formal = await readFile(path.join(config.vault_path, '40_Knowledge/formal.md'));
    const result = await batch(request, 'discard_drafts', [target(value, [value.drafts[0]!])]);
    expect(result.result.items[0]?.status).toBe('succeeded');
    expect(await (await request('/v1/sources?view=issues')).json()).toMatchObject({ total: 1 });
    expect((await (await request(`/v1/drafts?source_path=${source}`)).json()).items.map((item: any) => item.path)).toEqual(['30_Drafts/two.md']);
    const cleaned = await batch(request, 'discard', [target(await preview(request))]);
    expect(cleaned.result.items[0]?.status).toBe('succeeded');
    expect(await (await request('/v1/sources?view=all')).json()).toMatchObject({ total: 0, views: { all: 0, processing: 0, issues: 0 } });
    const status = await (await request('/v1/status')).json();
    const replay = await request('/v1/source-batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cleaned.input) });
    expect(await replay.json()).toEqual(cleaned.result);
    expect((await (await request('/v1/status')).json()).index_generation).toBe(status.index_generation);
    expect(await readFile(path.join(config.vault_path, '30_Drafts/two.md'), 'utf8')).toBe(draft('two'));
    expect(await readFile(path.join(config.vault_path, '40_Knowledge/formal.md'))).toEqual(formal);
    expect((await preview(request)).drafts.map(value => value.path)).toEqual(['30_Drafts/two.md']);
  } finally { await runtime.cleanup(); }
});

it('rejects restored same-byte Sources, changed Drafts and unrelated targets before changing any selected file', async () => {
  const runtime = await fixture(); const { config, request } = runtime;
  try {
    await finishedJob(request, (await submitScan(request)).job.id);
    await unlink(path.join(config.vault_path, source));
    const missing = await preview(request);
    await writeDocument(config.vault_path, source, sourceText);
    const restored = await batch(request, 'discard', [target(missing)]);
    expect(restored.result.items[0]).toMatchObject({ status: 'skipped', error: { code: 'SOURCE_CHANGED' } });
    expect(await readFile(path.join(config.vault_path, source), 'utf8')).toBe(sourceText);
    await unlink(path.join(config.vault_path, source));
    await writeDocument(config.vault_path, '30_Drafts/one.md', draft('one') + 'New user edit.\n');
    const changed = await batch(request, 'discard_drafts', [target(missing, missing.drafts)]);
    expect(changed.result.items[0]?.status).toBe('skipped');
    expect(await readFile(path.join(config.vault_path, '30_Drafts/one.md'), 'utf8')).toContain('lifecycle_status: active');
    expect(await readFile(path.join(config.vault_path, '30_Drafts/two.md'), 'utf8')).toBe(draft('two'));
    await writeDocument(config.vault_path, '30_Drafts/unrelated.md', draft('Unrelated', '20_Sources/other.md'));
    const unrelated = await preview(request, '20_Sources/other.md');
    const outside = await batch(request, 'discard_drafts', [target(await preview(request), unrelated.drafts)]);
    expect(outside.result.items[0]).toMatchObject({ status: 'skipped', error: { code: 'PATH_CONFLICT' } });
    expect(await readFile(path.join(config.vault_path, '30_Drafts/unrelated.md'), 'utf8')).toBe(draft('Unrelated', '20_Sources/other.md'));
    const unsafe = await batch(request, 'discard', [target(missing, missing.drafts)]);
    expect(unsafe.result.items[0]).toMatchObject({ status: 'failed', error: { code: 'VALIDATION_ERROR' } });
    const rejected = await request('/v1/source-batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), action: 'compile', items: [target(missing)] }) });
    expect(rejected.status).toBe(400);
  } finally { await runtime.cleanup(); }
});

it('handles a mixed Discard batch and preserves registrations when the Source root is unavailable', async () => {
  const runtime = await fixture(); const { config, request } = runtime;
  const existing = '20_Sources/existing.md';
  try {
    await writeDocument(config.vault_path, existing, sourceText);
    await writeDocument(config.vault_path, '30_Drafts/existing.md', draft('Existing', existing));
    await finishedJob(request, (await submitScan(request)).job.id);
    await unlink(path.join(config.vault_path, source));
    const missing = await preview(request), present = await preview(request, existing);
    const mixed = await batch(request, 'discard', [target(missing), target(present, present.drafts)]);
    expect(mixed.result.items.map(value => value.status)).toEqual(['succeeded', 'succeeded']);
    expect(await readFile(path.join(config.vault_path, '30_Drafts/one.md'), 'utf8')).toBe(draft('one'));
    expect(await readFile(path.join(config.vault_path, '30_Drafts/existing.md'), 'utf8')).toContain('lifecycle_status: discarded');
    expect(await readFile(path.join(config.vault_path, existing), 'utf8')).toContain('processing_status: compiled');
    await rename(path.join(config.vault_path, '20_Sources'), path.join(config.vault_path, 'unavailable'));
    const denied = await batch(request, 'discard', [{ path: existing, revision: present.source.revision, source_missing: true, request_id: randomUUID() }]);
    expect(denied.result.items[0]?.status).toBe('failed');
    const rebuild = await finishedJob(request, (await submitScan(request, 'rebuild')).job.id);
    expect(rebuild.status).toBe('failed');
    expect(await (await request('/v1/sources?view=discarded')).json()).toMatchObject({ total: 1 });
  } finally { await runtime.cleanup(); }
});
