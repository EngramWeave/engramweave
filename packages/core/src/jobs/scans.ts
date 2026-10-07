import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Job } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { scanVault } from '../discovery/scan.js';
import { retainFinishedJobs } from './retention.js';

interface JobRow { id: string; kind: Job['kind']; mode: Job['mode']; status: Job['status']; created_at: string; started_at: string | null;
  finished_at: string | null; processed_files: number; summary_json: string | null; error_json: string | null }
const asJob = (row: JobRow): Job => ({ id: row.id, kind: row.kind, mode: row.mode, status: row.status, created_at: row.created_at,
  started_at: row.started_at, finished_at: row.finished_at, processed_files: row.processed_files,
  summary: row.summary_json ? JSON.parse(row.summary_json) : null, error: row.error_json ? JSON.parse(row.error_json) : null });

export class ScanJobs {
  private running: Promise<void> | null = null;
  private stopping = false;
  constructor(private readonly db: Database.Database, private readonly vault: string, private readonly compilerBusy: () => boolean = () => false) {
    // Persisted activity is not runnable after a process restart; never pretend it is live.
    db.transaction(() => {
      db.prepare("UPDATE jobs SET status='interrupted',finished_at=?,error_json=? WHERE status IN ('queued','running')")
        .run(new Date().toISOString(), JSON.stringify({ code: 'CORE_UNAVAILABLE', message: 'Core exited before this scan completed', details: null }));
      retainFinishedJobs(db);
    })();
  }
  get(id: string): Job | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined; return row ? asJob(row) : undefined; }
  active(): Job | null { const row = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running')").get() as JobRow | undefined; return row ? asJob(row) : null; }
  list(limit: number, offset: number) {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC,id ASC LIMIT ? OFFSET ?').all(limit, offset) as JobRow[];
    return { items: rows.map(asJob), total: (this.db.prepare('SELECT count(*) AS count FROM jobs').get() as { count: number }).count, limit, offset };
  }
  submit(mode: Job['mode']): { job: Job; reused: boolean } {
    if (this.compilerBusy()) throw new CoreError('JOB_BUSY', 'Compiler is active; scan after its publication completes', 409);
    if (this.stopping) throw new CoreError('CORE_UNAVAILABLE', 'Core is stopping', 503);
    const active = this.active();
    if (active) {
      if (active.mode !== mode) throw new CoreError('JOB_BUSY', 'Another scan mode is active', 409);
      return { job: active, reused: true };
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at) VALUES(?,'scan_vault',?,'queued',?)").run(id, mode, new Date().toISOString());
    this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(id, mode));
    // Keep background database failures handled until close() can report them.
    void this.running.catch(() => {});
    return { job: this.get(id)!, reused: false };
  }
  private async execute(id: string, mode: Job['mode']) {
    try {
      this.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), id);
      await scanVault(this.db, this.vault, id, mode, processed => { this.db.prepare('UPDATE jobs SET processed_files=? WHERE id=?').run(processed, id); });
    } catch (error) {
      const safe = error instanceof CoreError ? { code: error.code, message: error.message, details: null }
        : { code: 'IO_ERROR', message: 'Scan could not be completed', details: null };
      try {
        this.db.transaction(() => {
          this.db.prepare("UPDATE jobs SET status='failed',finished_at=?,error_json=? WHERE id=?").run(new Date().toISOString(), JSON.stringify(safe), id);
          retainFinishedJobs(this.db);
        })();
      } catch {
        throw new CoreError('DATABASE_ERROR', 'Scan failure could not be persisted');
      }
    }
  }
  async close() { this.stopping = true; await this.running; }
}
