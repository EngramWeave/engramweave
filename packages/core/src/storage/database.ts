import Database from 'better-sqlite3';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, type Config } from '@engramweave/contracts';
import { pathKey } from '../config.js';
import { CoreError } from '../errors.js';

const schema = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source','knowledge')),
  state TEXT NOT NULL CHECK(state IN ('ready','invalid','missing','unsupported')),
  revision TEXT, size INTEGER, mtime REAL, title TEXT NOT NULL, source_type TEXT,
  captured_at TEXT, original_locator TEXT, metadata_json TEXT NOT NULL, asset_json TEXT,
  diagnostics_json TEXT NOT NULL, annotation TEXT NOT NULL, body_markdown TEXT NOT NULL,
  title_norm TEXT NOT NULL, body_norm TEXT NOT NULL, annotation_norm TEXT NOT NULL,
  metadata_norm TEXT NOT NULL, indexed_at TEXT NOT NULL
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
const columns = {
  documents: 'id path_key path kind state revision size mtime title source_type captured_at original_locator metadata_json asset_json diagnostics_json annotation body_markdown title_norm body_norm annotation_norm metadata_norm indexed_at'.split(' '),
  jobs: 'id kind mode status created_at started_at finished_at processed_files summary_json error_json'.split(' '),
  meta: 'id vault_path_key schema_version index_generation last_scan_at known_scan_roots'.split(' '),
};
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
      if (version !== SCHEMA_VERSION || tables.map(table => table.name).join(',') !== 'documents,jobs,meta') throw new CoreError('SCHEMA_UNSUPPORTED', 'Unsupported database schema');
      for (const [table, required] of Object.entries(columns)) {
        const actual = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (actual.map(column => column.name).join(',') !== required.join(',')) throw new CoreError('SCHEMA_UNSUPPORTED', 'Database layout does not match its version');
      }
      for (const statement of schema.split(';').map(item => item.trim()).filter(item => item.startsWith('CREATE'))) {
        const name = /^CREATE (?:TABLE|UNIQUE INDEX) (\w+)/.exec(statement)?.[1];
        const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined;
        if (!actual || normalizeDdl(actual.sql) !== normalizeDdl(statement)) throw new CoreError('SCHEMA_UNSUPPORTED', 'Database constraints do not match their version');
      }
      const meta = indexMeta(db);
      if (!meta || meta.schema_version !== SCHEMA_VERSION || !Number.isSafeInteger(meta.index_generation) || meta.index_generation < 0) throw new CoreError('SCHEMA_UNSUPPORTED', 'Invalid database binding metadata');
      const roots: unknown = JSON.parse(meta.known_scan_roots);
      if (!Array.isArray(roots) || roots.some(root => !['20_Sources', '40_Knowledge'].includes(root))) throw new CoreError('SCHEMA_UNSUPPORTED', 'Invalid scan root metadata');
      if (meta.vault_path_key !== pathKey(config.vault_path)) throw new CoreError('VAULT_MISMATCH', 'Database belongs to another Vault');
    }
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof CoreError) throw error;
    throw new CoreError('DATABASE_ERROR', 'Database could not be opened; preserve it for explicit recovery');
  }
}
