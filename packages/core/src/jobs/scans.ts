import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Job } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { scanVault } from '../discovery/scan.js';
import { retainFinishedJobs } from './retention.js';
import { VaultChanges } from '../discovery/changes.js';
import { ReferenceDependencies } from '../discovery/dependencies.js';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { SCAN_ROOTS } from '@engramweave/contracts';
import { documentPathKey, excludedName, normalizeVaultPath } from '../files/paths.js';
import { isPropertyArtifact } from '../files/properties.js';
import { isCaptureTemporaryName } from '../files/publication.js';

interface JobRow { id: string; kind: Job['kind']; mode: Job['mode']; status: Job['status']; created_at: string; started_at: string | null;
  finished_at: string | null; processed_files: number; summary_json: string | null; error_json: string | null }
const asJob = (row: JobRow): Job => ({ id: row.id, kind: row.kind, mode: row.mode, status: row.status, created_at: row.created_at,
  started_at: row.started_at, finished_at: row.finished_at, processed_files: row.processed_files,
  summary: row.summary_json ? JSON.parse(row.summary_json) : null, error: row.error_json ? JSON.parse(row.error_json) : null });

export class ScanJobs {
  private running: Promise<void> | null = null;
  private stopping = false;
  private activeFull = false;
  private changes: VaultChanges | undefined;
  private references = new ReferenceDependencies();
  constructor(private readonly db: Database.Database, private readonly vault: string, private readonly compilerBusy: () => boolean = () => false, private readonly afterScan: () => Promise<void> = async () => {}) {
    // Persisted activity is not runnable after a process restart; never pretend it is live.
    db.transaction(() => {
      db.prepare("UPDATE jobs SET status='interrupted',finished_at=?,error_json=? WHERE status IN ('queued','running')")
        .run(new Date().toISOString(), JSON.stringify({ code: 'CORE_UNAVAILABLE', message: 'Core exited before this scan completed', details: null }));
      retainFinishedJobs(db);
    })();
  }
  async startWatcher() {
    this.changes = new VaultChanges(this.vault);
    try { await this.changes.start(); } catch { /* Refresh reports a full-scan fallback; browsing stays usable. */ }
  }
  get(id: string): Job | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined; return row ? asJob(row) : undefined; }
  active(): Job | null { const row = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running')").get() as JobRow | undefined; return row ? asJob(row) : null; }
  list(limit: number, offset: number) {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC,id ASC LIMIT ? OFFSET ?').all(limit, offset) as JobRow[];
    return { items: rows.map(asJob), total: (this.db.prepare('SELECT count(*) AS count FROM jobs').get() as { count: number }).count, limit, offset };
  }
  submit(mode: Job['mode'], updateSemantic = true, forceFull = false): { job: Job; reused: boolean } {
    if (this.compilerBusy()) throw new CoreError('JOB_BUSY', 'Compiler is active; scan after its publication completes', 409);
    if (this.stopping) throw new CoreError('CORE_UNAVAILABLE', 'Core is stopping', 503);
    const active = this.active();
    if (active) {
      if (active.mode !== mode || this.activeFull !== forceFull) throw new CoreError('JOB_BUSY', 'Another scan mode is active', 409);
      return { job: active, reused: true };
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at) VALUES(?,'scan_vault',?,'queued',?)").run(id, mode, new Date().toISOString());
    this.activeFull = forceFull;
    this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(id, mode, updateSemantic, forceFull));
    // Keep background database failures handled until close() can report them.
    void this.running.catch(() => {});
    return { job: this.get(id)!, reused: false };
  }
  private async execute(id: string, mode: Job['mode'], updateSemantic: boolean, forceFull: boolean) {
    try {
      this.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), id);
      const snapshot = await this.changes?.capture();
      let selection;
      if (snapshot) {
        let reason = mode === 'rebuild' ? 'explicit_rebuild' : forceFull ? 'manual_reconciliation' : snapshot.reason;
        const selected: string[] = [];
        for (const input of snapshot.paths) {
          let relative;
          try { relative = normalizeVaultPath(input); } catch { reason = 'watcher_unknown_event'; continue; }
          const root = SCAN_ROOTS.find(value => value.toLowerCase() === relative.split('/')[0]!.toLowerCase());
          if (isPropertyArtifact(path.posix.basename(relative)) || isCaptureTemporaryName(path.posix.basename(relative))) {
            if (await lstat(path.join(this.vault, relative)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })) reason = 'property_recovery';
          }
          if (root && !relative.split('/').some(excludedName)) { const slash = relative.indexOf('/'); selected.push(root + (slash < 0 ? '' : relative.slice(slash))); }
        }
        // Collapse child hints when a directory/root hint already covers them.
        const distinct = new Map(selected.map(item => [documentPathKey(item), item]));
        const paths = [...distinct.values()].filter(item => {
          let key = documentPathKey(item), slash = key.lastIndexOf('/');
          while (slash >= 0) { key = key.slice(0, slash); if (distinct.has(key)) return false; slash = key.lastIndexOf('/'); }
          return true;
        });
        selection = { paths, owners: this.references.affected(snapshot.paths), reason };
      }
      let lastProgress = 0;
      await scanVault(this.db, this.vault, id, mode, processed => {
        const now = performance.now();
        if (processed % 64 === 0 || now - lastProgress >= 100) { this.db.prepare('UPDATE jobs SET processed_files=? WHERE id=?').run(processed, id); lastProgress = now; }
      }, selection);
      if (snapshot) { this.references.rebuild(this.db); this.changes!.completed(snapshot, selection!.reason !== null); }
      // Registration is already committed. Semantic failures must never rewrite that outcome.
      try { if (updateSemantic) await this.afterScan(); } catch { /* Independent semantic status owns its errors. */ }
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
  async close() { this.stopping = true; try { await this.running; } finally { await this.changes?.close(); } }
  async wait() { await this.running; }
}
