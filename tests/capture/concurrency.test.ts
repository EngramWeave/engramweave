import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { httpRuntime } from '../helpers/http.js';
import { submitCapture } from '../helpers/capture.js';
import { manualSource, sha256 } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('converges concurrent identical captures, rejects competing bytes, and never replaces existing files', async () => {
  const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
  const shared = manualSource('identical capture bytes');
  const results = await Promise.all(Array.from({ length: 4 }, () => submitCapture(request, '20_Sources/race.md', shared)));
  expect(results.map(result => result.status).sort()).toEqual([200, 200, 200, 201]);
  expect(await readFile(path.join(config.vault_path, '20_Sources/race.md'), 'utf8')).toBe(shared);
  const competitors = [manualSource('publisher one'), manualSource('publisher two')];
  const different = await Promise.all(competitors.map(markdown => submitCapture(request, '20_Sources/different.md', markdown)));
  expect(different.map(result => result.status).sort()).toEqual([201, 409]);
  expect(await readFile(path.join(config.vault_path, '20_Sources/different.md'), 'utf8')).toBe(competitors[different.findIndex(result => result.status === 201)]);
  const existing = Buffer.alloc(5 * 1024 * 1024 + 1, 65);
  const filename = path.join(config.vault_path, '20_Sources/existing.md'); await writeFile(filename, existing);
  const unrelated = path.join(config.vault_path, '20_Sources/.unrelated.tmp'); await writeFile(unrelated, 'do not delete');
  expect((await submitCapture(request, '20_Sources/existing.md', manualSource())).status).toBe(409);
  expect(sha256(await readFile(filename))).toBe(sha256(existing));
  expect(await readFile(unrelated, 'utf8')).toBe('do not delete');
  expect((await readdir(path.join(config.vault_path, '20_Sources'))).filter(name => name.startsWith('.engramweave-capture-'))).toEqual([]);
  if (process.env.P1_EVIDENCE === '1') {
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile('.local/p1/evidence/t09-concurrency.json', JSON.stringify({ identical: results, different, existing_sha256: sha256(existing), unrelated_temporary_preserved: true }, null, 2));
  }
}, 30_000);

it('saves independently of a real SQLite write failure without creating a Job or replacing earlier assets', async () => {
  const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
  const db = new Database(path.join(config.data_dir, 'core.sqlite')); cleanups.push(async () => { db.close(); });
  db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'injected database write failure'); END;");
  expect((await request('/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"refresh"}' })).status).toBe(500);
  const markdown = manualSource('databaseindependentcapture');
  const saved = await submitCapture(request, '20_Sources/preserved.md', markdown);
  expect(saved.status).toBe(201); expect(await readFile(path.join(config.vault_path, saved.body.path), 'utf8')).toBe(markdown);
  expect(db.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 0 });
  expect(await (await request('/v1/status')).json()).toMatchObject({ index_generation: 0 });
});
