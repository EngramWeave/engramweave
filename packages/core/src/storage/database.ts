import Database from 'better-sqlite3';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, type Config } from '@engramweave/contracts';
import { pathKey } from '../config.js';
import { CoreError } from '../errors.js';

const legacySchema = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source','knowledge')),
  state TEXT NOT NULL CHECK(state IN ('ready','invalid','missing','unsupported')),
  revision TEXT, size INTEGER, mtime REAL, title TEXT NOT NULL, source_type TEXT,
  captured_at TEXT, original_locator TEXT, metadata_json TEXT NOT NULL, asset_json TEXT,
  diagnostics_json TEXT NOT NULL, annotation TEXT NOT NULL, body_markdown TEXT NOT NULL,
  title_norm TEXT NOT NULL, body_norm TEXT NOT NULL, annotation_norm TEXT NOT NULL,
  metadata_norm TEXT NOT NULL, indexed_at TEXT
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='scan_vault'),
  mode TEXT NOT NULL CHECK(mode IN ('refresh','rebuild')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, processed_files INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT, error_json TEXT
);
CREATE UNIQUE INDEX one_active_scan ON jobs((1)) WHERE status IN ('queued','running');
CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK(id=1), vault_path_key TEXT NOT NULL, schema_version INTEGER NOT NULL,
  index_generation INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, known_scan_roots TEXT NOT NULL DEFAULT '[]'
);
PRAGMA user_version=1;`;
const compilerSchema = `
CREATE TABLE compiler_jobs (
  id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_revision TEXT NOT NULL,
  route TEXT NOT NULL CHECK(route IN ('api','codex')), model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, draft_path TEXT, error_json TEXT
);
CREATE UNIQUE INDEX one_active_compiler ON compiler_jobs((1)) WHERE status IN ('queued','running');`;
const version2Schema = legacySchema.replace('PRAGMA user_version=1;', '') + compilerSchema + '\nPRAGMA user_version=2;';
const version3Schema = version2Schema.replace("CHECK(kind IN ('source','knowledge'))", "CHECK(kind IN ('source','knowledge','idea','research'))").replace('PRAGMA user_version=2;', 'PRAGMA user_version=3;');
const analyzerSchema = `CREATE TABLE analyzer_jobs (id TEXT PRIMARY KEY, job_json TEXT NOT NULL CHECK(json_valid(job_json)), request_json TEXT NOT NULL CHECK(json_valid(request_json)));
CREATE UNIQUE INDEX one_active_analyzer ON analyzer_jobs((1)) WHERE json_extract(job_json,'$.status') IN ('queued','running');`;
const schema = version3Schema.replace('PRAGMA user_version=3;', '') + analyzerSchema + '\nPRAGMA user_version=4;';
const columns = {
  documents: 'id path_key path kind state revision size mtime title source_type captured_at original_locator metadata_json asset_json diagnostics_json annotation body_markdown title_norm body_norm annotation_norm metadata_norm indexed_at'.split(' '),
  jobs: 'id kind mode status created_at started_at finished_at processed_files summary_json error_json'.split(' '),
  meta: 'id vault_path_key schema_version index_generation last_scan_at known_scan_roots'.split(' '),
};
const compilerColumns = 'id source_path source_revision route model status created_at started_at finished_at draft_path error_json'.split(' ');
const normalizeDdl = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '').toLowerCase();
export interface IndexMeta { vault_path_key: string; schema_version: number; index_generation: number; last_scan_at: string | null; known_scan_roots: string }
export function indexMeta(db: Database.Database): IndexMeta { return db.prepare('SELECT * FROM meta WHERE id=1').get() as IndexMeta; }

export async function openDatabase(config: Config): Promise<Database.Database> {
  const filename = path.join(config.data_dir, 'core.sqlite');
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new CoreError('DATABASE_ERROR', 'Database must be a regular file with one filesystem name');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let db: Database.Database | undefined;
  try {
    db = new Database(filename);
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new CoreError('DATABASE_ERROR', 'Database integrity check failed');
    const version = db.pragma('user_version', { simple: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    if (version === 0 && tables.length === 0) {
      const initialize = db.transaction(() => {
        db!.exec(schema);
        db!.prepare('INSERT INTO meta(id,vault_path_key,schema_version) VALUES(1,?,?)').run(pathKey(config.vault_path), SCHEMA_VERSION);
      });
      initialize();
    } else {
      const legacy = version === 1;
      if (![1, 2, 3, SCHEMA_VERSION].includes(version as number) || tables.map(table => table.name).join(',') !== (legacy ? 'documents,jobs,meta' : version === 4 ? 'analyzer_jobs,compiler_jobs,documents,jobs,meta' : 'compiler_jobs,documents,jobs,meta')) throw new CoreError('SCHEMA_UNSUPPORTED', 'Unsupported database schema');
      for (const [table, required] of Object.entries(legacy ? columns : { ...columns, compiler_jobs: compilerColumns, ...(version === 4 ? { analyzer_jobs: ['id','job_json','request_json'] } : {}) })) {
        const actual = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (actual.map(column => column.name).join(',') !== required.join(',')) throw new CoreError('SCHEMA_UNSUPPORTED', 'Database layout does not match its version');
      }
      for (const statement of (legacy ? legacySchema : version === 2 ? version2Schema : version === 3 ? version3Schema : schema).split(';').map(item => item.trim()).filter(item => item.startsWith('CREATE'))) {
        const name = /^CREATE (?:TABLE|UNIQUE INDEX) (\w+)/.exec(statement)?.[1];
        const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined;
        if (!actual || normalizeDdl(actual.sql) !== normalizeDdl(statement)) throw new CoreError('SCHEMA_UNSUPPORTED', 'Database constraints do not match their version');
      }
      const meta = indexMeta(db);
      if (!meta || meta.schema_version !== version || !Number.isSafeInteger(meta.index_generation) || meta.index_generation < 0) throw new CoreError('SCHEMA_UNSUPPORTED', 'Invalid database binding metadata');
      const roots: unknown = JSON.parse(meta.known_scan_roots);
      if (!Array.isArray(roots) || roots.some(root => !(Number(version) >= 3 ? ['10_Ideas', '20_Sources', '40_Knowledge', '50_Research'] : ['20_Sources', '40_Knowledge']).includes(root))) throw new CoreError('SCHEMA_UNSUPPORTED', 'Invalid scan root metadata');
      if (meta.vault_path_key !== pathKey(config.vault_path)) throw new CoreError('VAULT_MISMATCH', 'Database belongs to another Vault');
      if (version !== SCHEMA_VERSION) db.transaction(() => {
        if (legacy) db!.exec(compilerSchema);
        db!.exec('ALTER TABLE documents RENAME TO documents_old;');
        db!.exec(schema.split(';').find(statement => statement.trim().startsWith('CREATE TABLE documents'))!);
        db!.exec('INSERT INTO documents SELECT * FROM documents_old; DROP TABLE documents_old;');
        db!.exec(analyzerSchema);
        db!.prepare('UPDATE meta SET schema_version=? WHERE id=1').run(SCHEMA_VERSION);
        db!.pragma(`user_version=${SCHEMA_VERSION}`);
      })();
    }
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof CoreError) throw error;
    throw new CoreError('DATABASE_ERROR', 'Database could not be opened; preserve it for explicit recovery');
  }
}
