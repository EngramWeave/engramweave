import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import * as reading from '../../packages/core/src/files/read.js';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('keeps old queries during rebuild and after a publication failure, then publishes the next complete generation on explicit retry', async () => {
  const { config, request, cleanup } = await httpRuntime(vault => writeDocument(vault, '20_Sources/item.md', manualSource('oldrebuildword'))); cleanups.push(cleanup);
  const initial = await submitScan(request); await finishedJob(request, initial.job.id);
  await writeDocument(config.vault_path, '20_Sources/item.md', manualSource('newrebuildword'));
  const db = new Database(path.join(config.data_dir, 'core.sqlite')); cleanups.push(async () => { db.close(); });
  db.exec("CREATE TRIGGER fail_rebuild BEFORE UPDATE OF index_generation ON meta BEGIN SELECT RAISE(ABORT,'injected rebuild publication failure'); END;");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const readingStarted = new Promise<void>(resolve => { entered = resolve; });
  const original = reading.readMarkdown;
  const spy = vi.spyOn(reading, 'readMarkdown').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
  const pending = await submitScan(request, 'rebuild');
  try {
    await readingStarted;
    expect(await (await request('/v1/search?scope=sources&q=oldrebuildword')).json()).toMatchObject({ total: 1, index_generation: 1 });
    expect(await (await request('/v1/search?scope=sources&q=newrebuildword')).json()).toMatchObject({ total: 0, index_generation: 1 });
  } finally { release(); }
  expect(await finishedJob(request, pending.job.id)).toMatchObject({ status: 'failed' });
  expect(await (await request('/v1/search?scope=sources&q=oldrebuildword')).json()).toMatchObject({ total: 1, index_generation: 1 });
  spy.mockRestore(); db.exec('DROP TRIGGER fail_rebuild');
  const retry = await submitScan(request, 'rebuild'); expect(await finishedJob(request, retry.job.id)).toMatchObject({ status: 'succeeded', summary: { index_generation: 2, updated: 1 } });
  expect(await (await request('/v1/search?scope=sources&q=oldrebuildword')).json()).toMatchObject({ total: 0, index_generation: 2 });
  expect(await (await request('/v1/search?scope=sources&q=newrebuildword')).json()).toMatchObject({ total: 1, index_generation: 2 });
});
