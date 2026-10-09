import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedRuntime } from '../helpers/runtime.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';
import { compilerFixture, waitCompiler } from '../helpers/compiler.js';
import { listDrafts } from '../../packages/core/src/drafts/files.js';
import { recoverDatabase } from '../../packages/core/src/storage/recover.js';
import { randomUUID } from 'node:crypto';
import { legacyDatabase } from '../helpers/legacy-database.js';

describe('B storage migration and asset recovery', () => {
  it('upgrades exact v1 schema atomically while retaining binding, existing jobs and index metadata', async () => {
    const runtime = await isolatedRuntime();
    try {
      await mkdir(runtime.config.data_dir);
      let db = await openDatabase(runtime.config);
      legacyDatabase(db, 1); db.exec('UPDATE meta SET index_generation=7;');
      db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at,finished_at) VALUES('old','scan_vault','refresh','succeeded','2026-10-01T00:00:00Z','2026-10-01T00:01:00Z')").run();
      db.close();
      db = await openDatabase(runtime.config);
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      expect(db.prepare('SELECT index_generation,schema_version FROM meta').get()).toEqual({ index_generation: 7, schema_version: 5 });
      expect(db.prepare('SELECT status FROM jobs WHERE id=?').get('old')).toEqual({ status: 'succeeded' });
      expect(db.prepare('SELECT count(*) AS total FROM compiler_jobs').get()).toEqual({ total: 0 });
      db.close();
    } finally { await runtime.cleanup(); }
  });
  it('rebuilds after actual database corruption without losing Draft edits, links or compiled stage', async () => {
    const fixture = await compilerFixture(async () => ({ title: 'Retained candidate', body: 'Generated body' }));
    let closed = false;
    try {
      const id = randomUUID();
      await fixture.compiler.submit({ path: fixture.sourcePath, revision: fixture.revision, request_id: id });
      const job = await waitCompiler(fixture.compiler, id);
      expect(job.status).toBe('succeeded');
      const filename = path.join(fixture.config.vault_path, job.draft_path!);
      const edited = (await readFile(filename, 'utf8')) + '\nUser edit that must survive DB corruption.\n';
      await writeFile(filename, edited);
      await fixture.compiler.close(); fixture.db.close(); closed = true;
      await writeFile(path.join(fixture.config.data_dir, 'core.sqlite'), 'corrupted test database');
      const recovered = await recoverDatabase(fixture.config);
      expect(recovered.job.status).toBe('succeeded');
      const drafts = await listDrafts(fixture.config.vault_path, fixture.sourcePath);
      expect(drafts.items).toHaveLength(1);
      expect(await readFile(filename, 'utf8')).toBe(edited);
      expect(await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8')).toContain('processing_status: compiled');
    } finally { if (closed) await fixture.cleanup(); else await fixture.close(); }
  }, 40_000);
});
