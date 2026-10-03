import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdir, link } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, indexMeta } from '../../packages/core/src/storage/database.js';
import { allDocuments, publishScan } from '../../packages/core/src/storage/registry.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { manualSource, sha256 } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: 'documents' }, { name: 'jobs' }, { name: 'meta' }]);
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
    expect(allDocuments(db)[1]).toMatchObject({ state: 'missing', body_markdown: '', metadata_json: '{}' });
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
  it('refuses Vault mismatch and unsupported versions without changing the original database', async () => {
    const { db, config, root } = await fixture();
    db.close();
    await expect(openDatabase({ ...config, vault_path: path.join(root, 'other-vault') })).rejects.toMatchObject({ code: 'VAULT_MISMATCH' });
    const foreign = new Database(path.join(config.data_dir, 'core.sqlite'));
    foreign.pragma('user_version=2'); foreign.close();
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    const intact = new Database(path.join(config.data_dir, 'core.sqlite'), { readonly: true });
    expect(intact.pragma('user_version', { simple: true })).toBe(2); intact.close();
  });
  it('rejects a version-one database with missing uniqueness and hard-linked database aliases', async () => {
    const { db, config, root } = await fixture();
    db.exec('DROP INDEX one_active_scan'); db.close();
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    await link(path.join(config.data_dir, 'core.sqlite'), path.join(root, 'database-alias.sqlite'));
    await expect(openDatabase(config)).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
  });
});
