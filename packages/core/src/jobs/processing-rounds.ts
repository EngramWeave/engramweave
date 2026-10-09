import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { LIMITS, type Config, type ProcessingRequest, type ProcessingRound } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown } from '../source/parse.js';
import { readDraft } from '../drafts/files.js';
import { registeredSourceBytes } from '../source/properties.js';
import { attemptError } from '../processing/retries.js';
import type { ProcessingSettingsStore } from '../processing/settings.js';
import type { ScanJobs } from './scans.js';
import type { CompilerJobs } from './compiler.js';
import type { AnalyzerJobs } from './analyzer.js';

export class ProcessingRounds {
  private accepting = false;
  private stopping = false;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly db: Database.Database, private readonly config: Config, private readonly scans: ScanJobs,
    private readonly compiler: CompilerJobs, private readonly analyzer: AnalyzerJobs, private readonly settings: ProcessingSettingsStore,
    private readonly otherBusy: () => boolean) {}
  private save(round: ProcessingRound, request: ProcessingRequest) {
    this.db.prepare('INSERT INTO processing_rounds VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET round_json=excluded.round_json').run(round.id, JSON.stringify(request), JSON.stringify(round));
  }
  get(id: string): ProcessingRound | null { const row = this.db.prepare('SELECT round_json FROM processing_rounds WHERE id=?').get(id) as { round_json: string } | undefined; return row ? JSON.parse(row.round_json) : null; }
  active(): ProcessingRound | null { const row = this.db.prepare("SELECT round_json FROM processing_rounds WHERE json_extract(round_json,'$.status') IN ('queued','running') LIMIT 1").get() as { round_json: string } | undefined; return row ? JSON.parse(row.round_json) : null; }
  busy() { return this.accepting || this.active() !== null; }
  list(limit: number = LIMITS.default_limit, offset: number = 0) {
    const rows = this.db.prepare("SELECT round_json FROM processing_rounds ORDER BY json_extract(round_json,'$.created_at') DESC,id DESC LIMIT ? OFFSET ?").all(limit, offset) as { round_json: string }[];
    return { items: rows.map(row => JSON.parse(row.round_json) as ProcessingRound), total: (this.db.prepare('SELECT count(*) AS count FROM processing_rounds').get() as { count: number }).count, limit, offset };
  }
  initialize() {
    for (const row of this.db.prepare("SELECT id,request_json FROM processing_rounds WHERE json_extract(round_json,'$.status') IN ('queued','running')").all() as { id: string; request_json: string }[]) {
      const round = this.get(row.id)!; round.status = 'interrupted'; round.finished_at = new Date().toISOString();
      for (const item of round.items) if (['pending','running'].includes(item.status)) { item.status = 'interrupted'; item.error = attemptError(new CoreError('EXECUTION_FAILED', 'Core restarted; queued work is not replayed')); }
      this.save(round, JSON.parse(row.request_json));
    }
  }
  private retain() {
    this.db.prepare("DELETE FROM processing_rounds WHERE id IN (SELECT id FROM processing_rounds WHERE json_extract(round_json,'$.status') NOT IN ('queued','running') ORDER BY json_extract(round_json,'$.created_at') DESC,id DESC LIMIT -1 OFFSET ?)").run(LIMITS.retained_finished_jobs);
  }
  async submit(request: ProcessingRequest, trigger: ProcessingRound['trigger'] = 'manual') {
    if (this.accepting || this.stopping) throw new CoreError('JOB_BUSY', 'Core is accepting a round or stopping', 409);
    this.accepting = true;
    try {
      const prior = this.get(request.request_id);
      if (prior) {
        const row = this.db.prepare('SELECT request_json FROM processing_rounds WHERE id=?').get(prior.id) as { request_json: string };
        if (!isDeepStrictEqual(JSON.parse(row.request_json), request)) throw new CoreError('PATH_CONFLICT', 'Round request ID was reused with different input', 409);
        return { round: prior, reused: true };
      }
      if (this.active() || this.otherBusy()) throw new CoreError('JOB_BUSY', 'A conflicting Core operation is active', 409);
      if (request.mode === 'pending' && request.items || request.mode !== 'pending' && !request.items?.length) throw new CoreError('VALIDATION_ERROR', 'Pending selects eligible Sources; selected/analysis rounds require explicit targets', 400);
      if (new Set(request.items?.map(item => (request.mode === 'analyze' ? item.draft_path : item.source_path)?.toLowerCase())).size !== (request.items?.length ?? 0)) throw new CoreError('VALIDATION_ERROR', 'Round targets must be distinct', 400);
      if (request.mode === 'analyze' && request.items?.some(item => !item.draft_path || !item.draft_revision || !item.source_revision)) throw new CoreError('VALIDATION_ERROR', 'Select explicit Source and Draft versions for analysis', 400);
      const round: ProcessingRound = { id: request.request_id, mode: request.mode, trigger, status: 'queued', created_at: new Date().toISOString(), started_at: null, finished_at: null,
        max_retries: this.settings.read().max_retries, registration_job_id: null, error: null, items: [] };
      this.retain(); this.save(round, request); this.controller = new AbortController();
      this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(round, request, this.controller!.signal));
      void this.running.catch(() => {}); return { round, reused: false };
    } finally { this.accepting = false; }
  }
  private async execute(round: ProcessingRound, request: ProcessingRequest, signal: AbortSignal) {
    try {
      round.status = 'running'; round.started_at = new Date().toISOString(); this.save(round, request);
      const normalized = new Map<string,string>();
      if (request.mode === 'selected') for (const item of request.items ?? []) if (item.source_revision) {
        try { const file = await readMarkdown(this.config.vault_path,item.source_path); if (file.revision === item.source_revision) normalized.set(item.source_path,createHash('sha256').update(registeredSourceBytes(item.source_path,file.bytes)).digest('hex')); }
        catch { /* Item-level errors are reported after the local registration step. */ }
      }
      if (request.mode !== 'analyze') {
        const scan = this.scans.submit('refresh', false); round.registration_job_id = scan.job.id; this.save(round, request); await this.scans.wait();
        if (this.scans.get(scan.job.id)?.status !== 'succeeded') throw new CoreError('INVALID_SOURCE', 'Local registration did not complete; no model was started', 422);
      }
      const selected: NonNullable<ProcessingRequest['items']> = request.mode === 'pending'
        ? (this.db.prepare("SELECT path,revision FROM documents WHERE kind='source' AND state='ready' AND json_extract(metadata_json,'$.processing_status') IN ('pending','reviewed') AND coalesce(json_extract(metadata_json,'$.lifecycle_status'),'active')='active' ORDER BY path_key").all() as { path: string; revision: string }[]).map(row => ({ source_path: row.path, source_revision: row.revision }))
        : request.items!;
      if (selected.length > LIMITS.scan_candidates) throw new CoreError('PAYLOAD_TOO_LARGE', 'Round exceeds the Source bound', 413);
      round.items = selected.map(item => ({ source_path: item.source_path, source_revision: normalized.get(item.source_path) ?? item.source_revision ?? null,
        draft_path: 'draft_path' in item ? item.draft_path ?? null : null, draft_revision: 'draft_revision' in item ? item.draft_revision ?? null : null,
        ...('task' in item && item.task ? { task: item.task } : {}), status: 'pending', phase: 'waiting', compiler_job_id: null, analyzer_job_id: null, error: null }));
      this.save(round, request);
      for (const [index, item] of round.items.entries()) {
        if (signal.aborted) { item.status = 'interrupted'; item.error = attemptError(new CoreError('EXECUTION_FAILED', 'Round was stopped before this item started')); continue; }
        item.status = 'running'; this.save(round, request);
        try {
          const source = await readMarkdown(this.config.vault_path, item.source_path); const parsed = parseMarkdown(item.source_path, source.bytes);
          if (item.source_revision && source.revision !== item.source_revision) throw new CoreError('SOURCE_CHANGED', 'Selected Source changed before processing', 409);
          if (parsed.state !== 'ready' || parsed.lifecycle_status !== 'active' || parsed.asset?.kind !== 'inline_markdown'
            || (request.mode === 'analyze' ? parsed.processing_status === 'archived' : !(request.mode === 'pending' ? ['pending'] : ['pending','compiled']).includes(parsed.processing_status ?? ''))) {
            item.status = 'skipped'; item.error = attemptError(new CoreError('INVALID_SOURCE', parsed.processing_status === 'reviewed' ? 'Reviewed Source is awaiting Planner; this phase does not execute planning' : 'Source is no longer eligible for this round', 422)); continue;
          }
          item.source_revision = source.revision;
          if (request.mode !== 'analyze') {
            signal.throwIfAborted(); item.phase = 'compiler';
            const compiled = await this.compiler.submit({ request_id: randomUUID(), path: item.source_path, revision: source.revision }, { maxRetries: round.max_retries });
            item.compiler_job_id = compiled.job.id; this.save(round, request); await this.compiler.wait();
            const job = this.compiler.get(compiled.job.id)!;
            if (job.status !== 'succeeded' || !job.draft_path) throw new CoreError(job.error?.code ?? 'EXECUTION_FAILED', job.error?.message ?? 'Compiler did not finish', 422);
            item.draft_path = job.draft_path; item.draft_revision = (await readDraft(this.config.vault_path, job.draft_path)).revision;
            item.source_revision = (await readMarkdown(this.config.vault_path, item.source_path)).revision;
          }
          signal.throwIfAborted(); item.phase = 'analyzer';
          const selection = selected[index]!;
          const analyzed = await this.analyzer.submit({ request_id: randomUUID(), source_path: item.source_path, source_revision: item.source_revision,
            draft_path: item.draft_path!, draft_revision: item.draft_revision!, ...('profile_id' in selection && selection.profile_id ? { profile_id: selection.profile_id } : {}), ...(item.task ? { task: item.task } : {}) }, { maxRetries: round.max_retries });
          item.analyzer_job_id = analyzed.job.id; this.save(round, request); await this.analyzer.wait();
          const job = this.analyzer.get(analyzed.job.id)!; item.status = job.status === 'succeeded' ? 'succeeded' : signal.aborted ? 'interrupted' : 'failed'; item.error = job.error;
        } catch (error) { item.status = signal.aborted ? 'interrupted' : 'failed'; item.error = attemptError(error); }
        finally { item.phase = 'finished'; this.save(round, request); }
      }
      round.status = signal.aborted ? 'interrupted' : round.items.some(item => item.status === 'failed') ? 'failed' : 'succeeded';
    } catch (error) { round.status = signal.aborted ? 'interrupted' : 'failed'; round.error = attemptError(error); }
    finally { round.finished_at = new Date().toISOString(); this.save(round, request); this.controller = null; }
  }
  async cancel(id: string) {
    if (this.active()?.id === id) { this.controller?.abort(); const compiler = this.compiler.active(); if (compiler) await this.compiler.cancel(compiler.id); const analyzer = this.analyzer.active(); if (analyzer) await this.analyzer.cancel(analyzer.id); await this.running; }
    const round = this.get(id); if (!round) throw new CoreError('JOB_NOT_FOUND', 'Processing round not found', 404); return round;
  }
  async wait() { await this.running; }
  async close() { this.stopping = true; const round = this.active(); if (round) await this.cancel(round.id); await this.running; }
}
