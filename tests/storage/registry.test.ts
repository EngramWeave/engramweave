import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdir, link, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, indexMeta } from '../../packages/core/src/storage/database.js';
import { allDocuments, publishScan, sourceItem } from '../../packages/core/src/storage/registry.js';
import { parseMarkdown, problemDocument } from '../../packages/core/src/source/parse.js';
import { FileProblem } from '../../packages/core/src/files/read.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { manualSource, sha256 } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  await mkdir(isolated.config.data_dir);
  const db = await openDatabase(isolated.config); cleanups.push(async () => { if (db.open) db.close(); });
  return { ...isolated, db };
}
function job(db: Database.Database, id: string) { db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at) VALUES(?,'scan_vault','refresh','running',?)").run(id, new Date().toISOString()); }
function projection(relative: string, text = manualSource()) { const bytes = Buffer.from(text); return { path: relative, parsed: parseMarkdown(relative, bytes), revision: sha256(bytes), size: bytes.length, mtime: 1 }; }

describe('real SQLite projection and transactions', () => {
  it('creates exactly the P1 tables and enforces one active scan', async () => {
    const { db } = await fixture();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: 'compiler_jobs' }, { name: 'documents' }, { name: 'jobs' }, { name: 'meta' }]);
    job(db, 'first');
    expect(() => job(db, 'second')).toThrow();
  });
  it('keeps same-path identity, distinct paths, and clears invalid or missing searchable text', async () => {
    const { db } = await fixture();
    job(db, 'a'); publishScan(db, 'a', [projection('20_Sources/one.md'), projection('20_Sources/two.md')], ['20_Sources'], []);
    const oldId = allDocuments(db)[0]!.id;
    job(db, 'b'); const repeated = publishScan(db, 'b', [projection('20_Sources/one.md'), projection('20_Sources/two.md')], ['20_Sources'], []);
    expect(repeated.unchanged).toBe(2); expect(allDocuments(db)[0]!.id).toBe(oldId);
    job(db, 'c'); publishScan(db, 'c', [projection('20_Sources/one.md', manualSource('changed'))], ['20_Sources'], []);
    expect(allDocuments(db)[1]).toMatchObject({ state: 'missing', body_markdown: '', metadata_norm: '', annotation: '' });
    expect(JSON.parse(allDocuments(db)[1]!.metadata_json).lifecycle_status).toBe('active');
    job(db, 'd'); publishScan(db, 'd', [projection('20_Sources/one.md', manualSource('secret', 'annotation: [invalid]\n'))], ['20_Sources'], []);
    expect(allDocuments(db)[0]).toMatchObject({ id: oldId, state: 'invalid', body_markdown: '', annotation: '', metadata_norm: '' });
  });
  it('rolls back every document, generation and successful Job when publication fails', async () => {
    const { db } = await fixture();
    job(db, 'a'); publishScan(db, 'a', [projection('20_Sources/one.md')], ['20_Sources'], []);
    const previous = allDocuments(db); const meta = indexMeta(db);
    job(db, 'b');
    db.exec("CREATE TRIGGER fail_publish BEFORE UPDATE OF index_generation ON meta BEGIN SELECT RAISE(ABORT,'injected publication failure'); END;");
    expect(() => publishScan(db, 'b', [projection('20_Sources/new.md')], ['20_Sources'], [])).toThrow();
    expect(allDocuments(db)).toEqual(previous); expect(indexMeta(db)).toEqual(meta);
    expect(db.prepare("SELECT status FROM jobs WHERE id='b'").get()).toEqual({ status: 'running' });
  });
  it('derives archival from metadata and advances file timestamps only after a successful content read', async () => {
    const { db } = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    const firstTime = '2026-10-04T01:00:00.000Z';
    const secondTime = '2026-10-04T02:00:00.000Z';
    const archived = projection('20_Sources/archived.md', manualSource('archive body', 'processing_status: archived\n'));
    vi.setSystemTime(new Date(firstTime));
    job(db, 'a'); publishScan(db, 'a', [archived, projection('20_Sources/later-missing.md')], ['20_Sources'], []);
    expect(sourceItem(allDocuments(db)[0]!)).toMatchObject({ state: 'ready', processing_status: 'archived' });
    expect(JSON.parse(allDocuments(db)[0]!.metadata_json).processing_status).toBe('archived');
    expect(db.prepare('PRAGMA table_info(documents)').all().map(column => (column as { name: string }).name)).not.toContain('processing_status');
    const failedRead = (relative: string) => ({ path: relative, parsed: problemDocument(relative, new FileProblem('FILE_UNSTABLE', 'invalid', 'Unstable file')), revision: null, size: null, mtime: null });
    vi.setSystemTime(new Date(secondTime));
    job(db, 'b');
    expect(publishScan(db, 'b', [archived, failedRead('20_Sources/never-read.md')], ['20_Sources'], [])).toMatchObject({ unchanged: 1, invalid: 1, missing: 1 });
    expect(allDocuments(db).map(row => [row.path, row.indexed_at])).toEqual([
      ['20_Sources/archived.md', secondTime], ['20_Sources/later-missing.md', firstTime], ['20_Sources/never-read.md', null],
    ]);
    expect(indexMeta(db).last_scan_at).toBe(secondTime);
    vi.setSystemTime(new Date('2026-10-04T03:00:00.000Z'));
    job(db, 'c'); publishScan(db, 'c', [failedRead(archived.path)], ['20_Sources'], []);
    expect(allDocuments(db)[0]).toMatchObject({ state: 'invalid', indexed_at: secondTime, body_markdown: '' });
  });
  it('refuses Vault mismatch and unsupported versions without changing the original database', async () => {
    const { db, config, root } = await fixture();
    db.close();
    await expect(openDatabase({ ...config, vault_path: path.join(root, 'other-vault') })).rejects.toMatchObject({ code: 'VAULT_MISMATCH' });
    const foreign = new Database(path.join(config.data_dir, 'core.sqlite'));
    foreign.pragma('user_version=4'); foreign.close();
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    const intact = new Database(path.join(config.data_dir, 'core.sqlite'), { readonly: true });
    expect(intact.pragma('user_version', { simple: true })).toBe(4); intact.close();
  });
  it('rejects a version-one database with missing uniqueness and hard-linked database aliases', async () => {
    const { db, config, root } = await fixture();
    db.exec('DROP INDEX one_active_scan'); db.close();
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    await link(path.join(config.data_dir, 'core.sqlite'), path.join(root, 'database-alias.sqlite'));
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
  });
  it('preserves an incompatible non-nullable timestamp database instead of silently changing it', async () => {
    const { db, config } = await fixture();
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='documents'").get() as { sql: string }).sql;
    db.exec('DROP TABLE documents'); db.exec(ddl.replace('indexed_at TEXT', 'indexed_at TEXT NOT NULL')); db.close();
    const filename = path.join(config.data_dir, 'core.sqlite');
    const previousHash = sha256(await readFile(filename));
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    expect(sha256(await readFile(filename))).toBe(previousHash);
  });
});
