import { describe, expect, it } from 'vitest';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';
import { legacyDatabase } from '../helpers/legacy-database.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';

it('migrates shipped v4 atomically without losing analysis receipts or projection metadata', async () => {
  const f = await analyzerFixture(async task => emptyAnalysis(task)); let db = f.db;
  try {
    const request = f.request(); await f.analyzer.submit(request); await f.analyzer.wait();
    legacyDatabase(db,4); db.prepare('UPDATE meta SET index_generation=42').run(); db.close(); db = await openDatabase(f.config);
    expect(db.pragma('user_version',{simple:true})).toBe(5); expect(db.prepare('SELECT index_generation FROM meta').get()).toEqual({index_generation:42});
    expect((db.prepare('SELECT count(*) AS total FROM analyzer_jobs').get() as {total:number}).total).toBe(1); expect(db.prepare('SELECT count(*) AS total FROM execution_attempts').get()).toEqual({total:0});
    db.exec('DROP INDEX recompile_source'); db.close(); await expect(openDatabase(f.config)).rejects.toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  } finally { if (db.open) db.close(); await f.cleanup(); }
});
