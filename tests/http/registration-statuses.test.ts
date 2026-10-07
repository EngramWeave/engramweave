import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PROCESSING_STATUSES } from '@engramweave/contracts';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { submitCapture } from '../helpers/capture.js';
import { manualSource, sha256, writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it('registers every file stage, independent lifecycle, and normalizes an old cached empty Source', async () => {
  const originals = new Map<string, string>();
  for (const stage of PROCESSING_STATUSES) originals.set(`20_Sources/${stage}.md`, manualSource(stage, `processing_status: ${stage}\nlifecycle_status: discarded\nannotation: Saved ${stage}\n`));
  const runtime = await httpRuntime(async vault => {
    for (const [relative, text] of originals) await writeDocument(vault, relative, text);
    await writeDocument(vault, '40_Knowledge/k.md', '---\nlifecycle_status: discarded\n---\nKnowledge');
  }); cleanups.push(runtime.cleanup);
  const { request, config } = runtime;
  for (const mode of ['refresh', 'refresh', 'rebuild']) {
    const scan = await submitScan(request, mode);
    expect(await finishedJob(request, scan.job.id)).toMatchObject({ status: 'succeeded', summary: { source_count: 5, knowledge_count: 1, invalid: 0 } });
    for (const [relative, text] of originals) {
      const current = await (await request(`/v1/documents?path=${relative}`)).json();
      expect(current).toMatchObject({ lifecycle_status: 'discarded', index_stale: false, revision: sha256(Buffer.from(text)) });
      expect(await readFile(path.join(config.vault_path, relative), 'utf8')).toBe(text);
    }
  }
  const list = await (await request('/v1/sources')).json();
  expect(list.items.map((item: { processing_status: string }) => item.processing_status).sort()).toEqual([...PROCESSING_STATUSES].sort());
  expect(await (await request('/v1/documents?path=40_Knowledge/k.md')).json()).toMatchObject({ lifecycle_status: 'discarded', body: 'Knowledge' });
  const empty = manualSource('Legacy body', 'annotation: Keep\n');
  const relative = '20_Sources/pending.md';
  await writeDocument(config.vault_path, relative, empty);
  // Reproduce a P1 ready row whose hash matches the current markerless file.
  const db = new Database(path.join(config.data_dir, 'core.sqlite')); cleanups.push(async () => { db.close(); });
  db.prepare('UPDATE documents SET revision=?,metadata_json=? WHERE path=?').run(sha256(Buffer.from(empty)), JSON.stringify({ type: 'raw_source', source_type: 'manual' }), relative);
  const scan = await submitScan(request);
  expect(await finishedJob(request, scan.job.id)).toMatchObject({ summary: { source_count: 5, invalid: 0 } });
  const current = await (await request(`/v1/documents?path=${relative}`)).json();
  expect(current).toMatchObject({ processing_status: 'pending', lifecycle_status: 'active', annotation: 'Keep', source_content: 'Legacy body', index_stale: false });
  const invalidKnowledge = '---\nlifecycle_status: failed\n---\nKnowledge';
  await writeDocument(config.vault_path, '40_Knowledge/k.md', invalidKnowledge);
  db.prepare('UPDATE documents SET revision=?,metadata_json=? WHERE path=?').run(sha256(Buffer.from(invalidKnowledge)), JSON.stringify({ lifecycle_status: 'failed' }), '40_Knowledge/k.md');
  const validation = await submitScan(request);
  expect(await finishedJob(request, validation.job.id)).toMatchObject({ summary: { invalid: 1, knowledge_count: 0, source_count: 5 } });
});
it('replays original Capture after registration and rejects every user change without writing or starting Jobs', async () => {
  const runtime = await httpRuntime(); cleanups.push(runtime.cleanup);
  const { request, config } = runtime;
  const relative = '20_Sources/capture.md';
  const original = manualSource('Submitted body', 'annotation: My understanding\nunknown: retained\n');
  expect(await submitCapture(request, relative, original)).toMatchObject({ status: 201 });
  const scan = await submitScan(request); expect(await finishedJob(request, scan.job.id)).toMatchObject({ status: 'succeeded' });
  const normalized = await readFile(path.join(config.vault_path, relative), 'utf8');
  expect(normalized).toBe(original.replace('---\n', '---\nprocessing_status: pending\n'));
  expect(await submitCapture(request, relative, original)).toMatchObject({ status: 200, body: { created: false, revision: sha256(Buffer.from(normalized)) } });
  for (const changed of [normalized + '\nEdit', normalized.replace('My understanding', 'Updated understanding'), normalized.replace('unknown: retained', 'unknown: changed'), normalized.replace('processing_status: pending', 'processing_status: compiled'), normalized.replaceAll('\n', '\r\n')]) {
    await writeDocument(config.vault_path, relative, changed);
    expect(await submitCapture(request, relative, original)).toMatchObject({ status: 409 });
    expect(await readFile(path.join(config.vault_path, relative), 'utf8')).toBe(changed);
  }
  expect(await (await request('/v1/jobs')).json()).toMatchObject({ total: 1 });
});
