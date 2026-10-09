import { describe, expect, it } from 'vitest';
import { analyzerFixture } from '../helpers/analyzer.js';
import { legacyDatabase } from '../helpers/legacy-database.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('C2 database migration', () => {
  it('adds analysis receipt indexes to shipped v3 while preserving jobs, metadata and all user files', async () => {
    const f = await analyzerFixture(); let db = f.db;
    try {
      const before = await Promise.all([f.sourcePath, f.draftPath].map(p => readFile(path.join(f.config.vault_path, p))));
      legacyDatabase(db, 3); db.prepare('UPDATE meta SET index_generation=17').run();
      db.prepare("INSERT INTO compiler_jobs(id,source_path,source_revision,route,model,status,created_at) VALUES('old',?,?,'api','previous-model','failed','2026-10-01T00:00:00Z')").run(f.sourcePath, f.request().source_revision);
      db.close(); db = await openDatabase(f.config);
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      expect(db.prepare('SELECT index_generation FROM meta').get()).toEqual({ index_generation: 17 });
      expect(db.prepare('SELECT status,model FROM compiler_jobs').get()).toEqual({ status: 'failed', model: 'previous-model' });
      expect(db.prepare('SELECT count(*) AS total FROM analyzer_jobs').get()).toEqual({ total: 0 });
      expect(await Promise.all([f.sourcePath, f.draftPath].map(p => readFile(path.join(f.config.vault_path, p))))).toEqual(before);
      db.exec('DROP INDEX one_active_analyzer'); db.close();
      await expect(openDatabase(f.config)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    } finally { if (db.open) db.close(); await f.cleanup(); }
  });
});
