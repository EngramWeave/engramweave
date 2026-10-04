import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rename, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { LIMITS } from '@engramweave/contracts';
import { scanVault } from '../../packages/core/src/discovery/scan.js';
import { openDatabase, indexMeta } from '../../packages/core/src/storage/database.js';
import { allDocuments } from '../../packages/core/src/storage/registry.js';
import * as reading from '../../packages/core/src/files/read.js';
import * as promises from 'node:fs/promises';
import { isolatedRuntime } from '../helpers/runtime.js';
import { copyRealSamples, realSamples, sha256, manualSource, writeDocument } from '../helpers/fixtures.js';
vi.mock('node:fs/promises', { spy: true });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  await mkdir(isolated.config.data_dir); await copyRealSamples(isolated.config.vault_path);
  const db = await openDatabase(isolated.config); cleanups.push(async () => { db.close(); });
  let sequence = 0;
  const scan = async (mode: 'refresh' | 'rebuild' = 'refresh') => {
    const id = `job-${++sequence}`;
    db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at) VALUES(?,'scan_vault',?,'running',?)").run(id, mode, new Date().toISOString());
    try { return await scanVault(db, isolated.config.vault_path, id, mode, () => {}); }
    catch (error) { db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id); throw error; }
  };
  return { ...isolated, db, scan };
}

describe('explicit full scan publication', () => {
  it('registers exactly two real Sources, treats missing Knowledge as empty and preserves revisions on refresh/rebuild', async () => {
    const { config, db, scan } = await fixture();
    expect(await scan()).toMatchObject({ added: 2, source_count: 2, knowledge_count: 0, index_generation: 1 });
    const ids = allDocuments(db).map(row => row.id);
    expect(await scan()).toMatchObject({ added: 0, unchanged: 2, index_generation: 2 });
    expect(await scan('rebuild')).toMatchObject({ unchanged: 2, index_generation: 3 });
    expect(allDocuments(db).map(row => row.id)).toEqual(ids);
    for (const sample of realSamples) expect(sha256(await readFile(path.join(config.vault_path, sample.path)))).toBe(sample.hash);
  });
  it('reports invalid/unsupported files and ignores temporary, hidden and linked directories', async () => {
    const { config, scan } = await fixture();
    await writeDocument(config.vault_path, '20_Sources/bad.md', manualSource('body', 'annotation: [bad]\n'));
    await writeDocument(config.vault_path, '20_Sources/plain.md', 'ordinary note');
    await writeDocument(config.vault_path, '20_Sources/.hidden/ignored.md', manualSource());
    await writeDocument(config.vault_path, '20_Sources/.capture.tmp.md', manualSource());
    await writeDocument(config.vault_path, '20_Sources/windows-hidden/ignored.md', manualSource());
    await promisify(execFile)(path.join(process.env.SystemRoot!, 'System32/attrib.exe'), ['+H', path.join(config.vault_path, '20_Sources/windows-hidden')], { windowsHide: true });
    await symlink(path.join(config.vault_path, '20_Sources/Web'), path.join(config.vault_path, '20_Sources/link'), 'junction');
    expect(await scan()).toMatchObject({ added: 2, invalid: 1, unsupported: 1, source_count: 2 });
  });
  it('preserves the entire preceding generation when enumeration fails or a previously present root disappears', async () => {
    const { config, db, scan } = await fixture();
    await scan(); const previous = allDocuments(db); const meta = indexMeta(db);
    const readdir = vi.spyOn(promises, 'readdir').mockRejectedValueOnce(Object.assign(new Error('injected failure'), { code: 'EACCES' }));
    await expect(scan()).rejects.toMatchObject({ code: 'IO_ERROR' }); readdir.mockRestore();
    expect(allDocuments(db)).toEqual(previous); expect(indexMeta(db)).toEqual(meta);
    await rename(path.join(config.vault_path, '20_Sources'), path.join(config.vault_path, 'sources-offline'));
    await expect(scan()).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(allDocuments(db)).toEqual(previous); expect(indexMeta(db)).toEqual(meta);
  });
  it('retains the previous generation when the actual byte budget is exceeded', async () => {
    const { config, db, scan } = await fixture();
    await scan(); const previous = allDocuments(db); const meta = indexMeta(db);
    for (let i = 0; i < 21; i++) await writeDocument(config.vault_path, `20_Sources/large-${i}.md`, Buffer.alloc(LIMITS.markdown_bytes, 65));
    await expect(scan()).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(allDocuments(db)).toEqual(previous); expect(indexMeta(db)).toEqual(meta);
  });
  it('publishes an unstable file as invalid without retaining its preceding body', async () => {
    const { db, scan, config } = await fixture();
    await scan();
    const previousTime = allDocuments(db).find(row => row.path === realSamples[0]!.path)!.indexed_at;
    await writeDocument(config.vault_path, '20_Sources/never-read.md', manualSource());
    const original = reading.readMarkdown;
    vi.spyOn(reading, 'readMarkdown').mockImplementation(async (...args) => {
      if (args[1] === realSamples[0]!.path || args[1] === '20_Sources/never-read.md') throw new reading.FileProblem('FILE_UNSTABLE', 'invalid', 'Document changed during both attempts');
      return original(...args);
    });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(await scan()).toMatchObject({ invalid: 2, source_count: 1, unchanged: 1 });
    expect(allDocuments(db).find(row => row.path === realSamples[0]!.path)).toMatchObject({ state: 'invalid', body_markdown: '', indexed_at: previousTime });
    expect(allDocuments(db).find(row => row.path === '20_Sources/never-read.md')).toMatchObject({ state: 'invalid', indexed_at: null });
    expect(indexMeta(db).last_scan_at).toBe('2030-01-01T00:00:00.000Z');
  });
  it('fails without publishing when more than 10,000 real candidate files are enumerated', async () => {
    const { db, config, scan } = await fixture();
    await scan(); const previous = allDocuments(db); const meta = indexMeta(db);
    const directory = path.join(config.vault_path, '20_Sources/candidates'); await mkdir(directory);
    for (let batch = 0; batch < LIMITS.scan_candidates + 1; batch += 100) {
      await Promise.all(Array.from({ length: Math.min(100, LIMITS.scan_candidates + 1 - batch) }, (_value, index) => writeFile(path.join(directory, `${batch + index}.md`), '')));
    }
    await expect(scan()).rejects.toMatchObject({ code: 'IO_ERROR', message: 'Scan exceeds the candidate count limit' });
    expect(allDocuments(db)).toEqual(previous); expect(indexMeta(db)).toEqual(meta);
  }, 30_000);
});
