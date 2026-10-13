import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import type Database from 'better-sqlite3';
import { PlannerJobSchema, PlanRequestSchema, type Config, type PlannerJob, type PlanRequest, type ChangeSet } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { executeCodexText } from '../execution/codex.js';
import { analysisToolBridge } from '../analysis/tools.js';
import { planningInput, type PlanningSnapshot } from '../planning/input.js';
import { PlannerSettingsStore, plannerExecution } from '../planning/settings.js';
import { PlanningTools, plannerTools } from '../planning/tools.js';
import { ChangeSets } from '../changesets/store.js';
import type { SemanticRecall } from '../recall/index.js';
import type { HumanReviewActions } from '../review/human.js';
import type { AnalyzerJobs } from './analyzer.js';
import { inferWithRetries, attemptError } from '../processing/retries.js';
import { readMarkdown } from '../files/read.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { writeSourceProperties, recoverPropertyJournal, isPropertyJournal } from '../files/properties.js';
import { PropertyNative } from '../files/property-native.js';
import { parseMarkdown } from '../source/parse.js';
import { updateCompiledSource } from '../storage/registry.js';
import { resolveVaultDirectory } from '../files/paths.js';
import { changeSetId } from '../changesets/paths.js';
import { windowsAttributes } from '../files/windows.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface Record { version: 1; request: PlanRequest; job: PlannerJob; snapshot: PlanningSnapshot; phase: 'generating' | 'prepared' | 'ready' | 'completed' | 'canceled';
  source_after: string | null; observations: PlanningTools['observations'] }
export type PlannerExecutor = (snapshot: PlanningSnapshot, tools: PlanningTools, signal: AbortSignal) => Promise<{ changeset_id: string; summary: string }>;
const resultSchema = { type: 'object', additionalProperties: false, required: ['changeset_id','summary'], properties: { changeset_id: { type: 'string' }, summary: { type: 'string', maxLength: 8000 } } };
export class PlannerJobs {
  readonly settings: PlannerSettingsStore; readonly changesets: ChangeSets;
  private running: Promise<void> | null = null; private controller: AbortController | null = null; private accepting = false; private stopping = false;
  private readonly unresolved = new Set<string>(); private readonly directory: string;
  constructor(private readonly db: Database.Database, private readonly config: Config, private readonly recall: Pick<SemanticRecall, 'recall' | 'context'>,
    private readonly human: HumanReviewActions, private readonly otherBusy: () => boolean, private readonly analyzer?: AnalyzerJobs, private readonly executor?: PlannerExecutor,
    private readonly retryLimit: () => number = () => 0) {
    this.settings = new PlannerSettingsStore(config); this.changesets = new ChangeSets(config); this.directory = path.join(config.data_dir, 'planner-jobs');
  }
  private executionOwns: (id: string) => boolean = () => false;
  protectExecutions(owns: (id: string) => boolean) { this.executionOwns = owns; }
  private guardExecution(id: string) { if (this.executionOwns(id)) throw new CoreError('PATH_CONFLICT', 'Accepted ChangeSet cannot be canceled or replanned; inspect its execution', 409); }
  busy() { return this.accepting || this.running !== null || this.unresolved.size > 0; }
  get(id: string): PlannerJob | null { const row = this.db.prepare('SELECT job_json FROM planner_jobs WHERE id=?').get(id) as { job_json: string } | undefined; return row ? JSON.parse(row.job_json) : null; }
  all(): PlannerJob[] { return (this.db.prepare('SELECT job_json FROM planner_jobs').all() as { job_json: string }[]).map(row => JSON.parse(row.job_json)); }
  active() { return this.all().find(job => ['queued','running'].includes(job.status)) ?? null; }
  private filename(id: string) { return path.join(this.directory, `${changeSetId(id)}.json`); }
  private async safeDirectory(create = false) {
    if (create) await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([this.directory]))[0]?.reparse)) throw new CoreError('CONFIG_ERROR', 'Planner receipt directory is unsafe', 400);
    return Boolean(info);
  }
  private async save(record: Record) {
    await this.safeDirectory(true); await atomicWrite(this.filename(record.job.id), JSON.stringify(record), 32 * 1024 * 1024);
    this.db.prepare('INSERT INTO planner_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET job_json=excluded.job_json').run(record.job.id, JSON.stringify(record.job), JSON.stringify(record.request));
  }
  private async read(id: string): Promise<Record | null> {
    if (!await this.safeDirectory()) return null;
    const bytes = await regularRead(this.filename(id), 32 * 1024 * 1024); if (!bytes) return null;
    let record: Record;
    try { record = JSON.parse(bytes.toString()); } catch { throw new CoreError('CONFIG_ERROR', 'Invalid Planner receipt; preserved', 400); }
    if (record.version !== 1 || !Value.Check(PlannerJobSchema, record.job) || !Value.Check(PlanRequestSchema, record.request) || record.job.id !== id || record.request.request_id !== id
      || !['generating','prepared','ready','completed','canceled'].includes(record.phase) || record.snapshot.source.path !== record.job.source_path
      || hash(Buffer.from(record.snapshot.source.content)) !== record.job.source_revision || hash(Buffer.from(record.snapshot.draft.content)) !== record.job.draft_revision) throw new CoreError('CONFIG_ERROR', 'Planner receipt identity or input is invalid', 400);
    return record;
  }
  async initialize() {
    await this.settings.initialize(); if (!await this.safeDirectory()) return;
    const names = (await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    if (names.length > 10000) throw new CoreError('CONFIG_ERROR', 'Planner history exceeds recovery bound', 400);
    for (const name of names) {
      const record = (await this.read(name.slice(0,-5)))!;
      if (['prepared','ready'].includes(record.phase)) {
        this.unresolved.add(record.job.id);
        try { await this.finish(record); } catch (error) { record.job.status = 'failed'; record.job.error = attemptError(error); }
      } else if (['queued','running'].includes(record.job.status)) { record.job.status = 'interrupted'; record.job.error = attemptError(new CoreError('EXECUTION_FAILED', 'Core exited before Planner completed; inference was not replayed')); record.job.finished_at = new Date().toISOString(); }
      await this.save(record);
      if(record.phase==='canceled'&&record.job.changeset_id){
        await this.returnReviewed(record);
        try{await this.changesets.cancel(record.job.changeset_id);}catch(error){if(!(error instanceof CoreError&&error.code==='DOCUMENT_NOT_FOUND'))throw error;}
      }
      if (record.phase === 'completed' && record.job.changeset_id && !this.executionOwns(record.job.changeset_id)) {
        try { await this.changesets.verifyCandidates(record.job.changeset_id); }
        catch (error) {
          if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') {
            record.phase = 'canceled'; await this.save(record);await this.returnReviewed(record);
            try{await this.changesets.cancel(record.job.changeset_id);}catch(cleanup){if(!(cleanup instanceof CoreError&&cleanup.code==='DOCUMENT_NOT_FOUND'))throw cleanup;}
          } else throw error;
        }
      }
    }
  }
  async submit(request: PlanRequest, options: { maxRetries?: number } = {}) {
    if (!Value.Check(PlanRequestSchema, request)) throw new CoreError('VALIDATION_ERROR', 'Invalid planning request', 400);
    if (this.accepting || this.running || this.stopping) throw new CoreError('JOB_BUSY', 'Planner is running or stopping', 409);
    this.accepting = true;
    try {
      let record = await this.read(request.request_id);
      if (record) {
        if (!isDeepStrictEqual(record.request, request)) throw new CoreError('PATH_CONFLICT', 'Planning request ID belongs to different input', 409);
        if (['prepared','ready'].includes(record.phase)) await this.finish(record);
        return { job: record.job, reused: true };
      }
      if (this.otherBusy() || this.unresolved.size) throw new CoreError('JOB_BUSY', 'Finish the active workflow or unresolved planning publication', 409);
      if ((await this.readyForSource(request.source_path)).length) throw new CoreError('PATH_CONFLICT', 'Inspect or cancel the existing ready ChangeSet before replanning', 409);
      const snapshot = await planningInput(this.config, request.source_path, this.human, this.settings, this.analyzer);
      if (request.source_revision && request.source_revision !== snapshot.source.revision) throw new CoreError('SOURCE_CHANGED', 'Source changed before planning', 409);
      const job: PlannerJob = { id: request.request_id, kind: 'plan_integration', status: 'queued', created_at: new Date().toISOString(), started_at: null, finished_at: null,
        source_path: snapshot.source.path, source_revision: snapshot.source.revision, draft_path: snapshot.draft.path, draft_revision: snapshot.draft.revision,
        model: snapshot.settings.model, changeset_id: null, error: null, attempts: [] };
      record = { version: 1, request, job, snapshot, phase: 'generating', source_after: null, observations: [] }; await this.save(record);
      this.controller = new AbortController();
      this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(record!, this.controller!.signal, options.maxRetries ?? this.retryLimit())).finally(() => { this.running = null; this.controller = null; });
      return { job, reused: false };
    } finally { this.accepting = false; }
  }
  private async execute(record: Record, signal: AbortSignal, maxRetries: number) {
    try {
      record.job.status = 'running'; record.job.started_at = new Date().toISOString(); await this.save(record);
      await inferWithRetries(this.db, record.job.id, 'planner', async () => {
        const snapshot = record.snapshot;
        const manifest = await this.changesets.create({ source_path: snapshot.source.path, source_revision: snapshot.source.revision, draft_path: snapshot.draft.path,
          draft_revision: snapshot.draft.revision, intent: snapshot.intent, model: snapshot.settings.model });
        record.job.changeset_id = manifest.id; await this.save(record);
        const taskSignal = AbortSignal.any([signal, AbortSignal.timeout(snapshot.settings.timeout_seconds * 1000)]);
        const tools = new PlanningTools(snapshot, manifest.id, this.config, this.changesets, this.recall, taskSignal);
        let result: { changeset_id: string; summary: string };
        try {
          if (this.executor) result = await this.executor(snapshot, tools, taskSignal);
          else {
            const bridge = await analysisToolBridge(tools, taskSignal, 8 * 1024 * 1024);
            try { result = JSON.parse(await executeCodexText(plannerExecution(snapshot.settings), this.config.data_dir,
              JSON.stringify({ changeset_id: manifest.id, source: snapshot.source, draft: snapshot.draft, intent: snapshot.intent, relation: snapshot.relation, relation_template: snapshot.template.relation }), taskSignal,
              snapshot.template.content, resultSchema, { command: process.execPath, script: fileURLToPath(new URL('../planning/mcp.js', import.meta.url)), env: bridge.env, namespace: 'planning', tools: plannerTools.map(tool => tool.name) })); }
            finally { await bridge.close(); }
          }
          if (!result || result.changeset_id !== manifest.id || typeof result.summary !== 'string' || result.summary.length > 8000) throw new CoreError('INVALID_MODEL_OUTPUT', 'Planner result must reference its assigned ChangeSet', 422);
          taskSignal.throwIfAborted();
        } finally { record.observations = tools.observations; await this.save(record); }
      }, { maxRetries, signal, onAttempt: async attempts => { record.job.attempts = attempts; await this.save(record); } });
      signal.throwIfAborted(); record.phase = 'prepared'; await this.save(record); this.unresolved.add(record.job.id); await this.finish(record);
    } catch (error) {
      if (record.phase === 'prepared' && error instanceof CoreError && ['INVALID_MODEL_OUTPUT','VALIDATION_ERROR'].includes(error.code)) { record.phase = 'generating'; this.unresolved.delete(record.job.id); }
      record.job.status = signal.aborted ? 'interrupted' : 'failed'; record.job.error = attemptError(error); record.job.finished_at = new Date().toISOString(); await this.save(record);
    }
  }
  private async finish(record: Record) {
    if (!record.job.changeset_id) throw new CoreError('PATH_CONFLICT', 'Planning publication has no ChangeSet', 409);
    const {manifest}=await this.changesets.read(record.job.changeset_id);
    if (manifest.source_path !== record.snapshot.source.path || manifest.draft_path !== record.snapshot.draft.path
      || manifest.source_revision!==record.job.source_revision||manifest.draft_revision!==record.job.draft_revision||manifest.intent!==record.snapshot.intent||manifest.model!==record.snapshot.settings.model) throw new CoreError('PATH_CONFLICT', 'ChangeSet no longer matches the selected input', 409);
    await this.changesets.publish(record.job.changeset_id);
    record.phase = 'ready'; await this.save(record);
    if (await this.human.selection(record.job.source_path) !== record.job.draft_path) throw new CoreError('SOURCE_CHANGED', 'Planning permission was withdrawn', 409);
    const native = new PropertyNative();
    try {
      const parent = path.posix.dirname(record.job.source_path);
      for (const name of (await readdir(await resolveVaultDirectory(this.config.vault_path, parent))).filter(isPropertyJournal)) await recoverPropertyJournal(this.config.vault_path, parent, name, native);
      const current = await readMarkdown(this.config.vault_path, record.job.source_path);
      const bytes = editScalarProperty(Buffer.from(record.snapshot.source.content), 'processing_status', 'planned'); const after = hash(bytes);
      if (current.revision !== record.job.source_revision && current.revision !== after) throw new CoreError('SOURCE_CHANGED', 'Source changed before planned-stage publication; candidate remains preserved', 409);
      record.source_after = after; await this.save(record);
      const next = current.revision === after ? current : await writeSourceProperties(this.config.vault_path, record.job.source_path, current, bytes, native);
      updateCompiledSource(this.db, record.job.source_path, next, parseMarkdown(record.job.source_path, next.bytes));
    } finally { await native.close(); }
    record.phase = 'completed'; record.job.status = 'succeeded'; record.job.error = null; record.job.finished_at = new Date().toISOString(); await this.save(record); this.unresolved.delete(record.job.id);
  }
  private async returnReviewed(record: Record) {
    if ((await this.readyForSource(record.job.source_path, record.job.changeset_id)).length) return;
    const source = await readMarkdown(this.config.vault_path, record.job.source_path); const parsed = parseMarkdown(record.job.source_path, source.bytes);
    if (parsed.processing_status === 'planned' && await this.human.selection(record.job.source_path) === record.job.draft_path) {
      const native = new PropertyNative(); try { const bytes = editScalarProperty(source.bytes, 'processing_status', 'reviewed'); const next = await writeSourceProperties(this.config.vault_path, record.job.source_path, source, bytes, native); updateCompiledSource(this.db, record.job.source_path, next, parseMarkdown(record.job.source_path, next.bytes)); } finally { await native.close(); }
    }
  }
  async readyForSource(source: string, exclude: string | null = null): Promise<ChangeSet[]> {
    // Only receipts for this Source own its flow; unrelated corrupt workspaces remain browsing diagnostics.
    const manifests: ChangeSet[] = [];
    for (const job of this.all()) {
      if (!job.changeset_id || job.changeset_id === exclude || job.source_path.toLowerCase() !== source.toLowerCase() || this.executionOwns(job.changeset_id)) continue;
      try {
        const { manifest } = await this.changesets.read(job.changeset_id);
        if (manifest.source_path.toLowerCase() !== source.toLowerCase() || manifest.draft_path.toLowerCase() !== job.draft_path.toLowerCase()) throw new CoreError('PATH_CONFLICT', 'ChangeSet inputs no longer match its planning receipt', 409);
        if (manifest.state === 'ready') manifests.push(manifest);
      }
      catch (error) { if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error; }
    }
    return manifests;
  }
  async cancelChangeSet(id: string, toCompiled = false) {
    if (this.running||this.accepting) throw new CoreError('JOB_BUSY', 'Wait for or cancel the running Planner', 409);
    this.guardExecution(id);
    const manifest = (await this.changesets.read(id)).manifest;
    const job = this.all().find(job => job.changeset_id === id); const record = job ? await this.read(job.id) : null;
    if (!record) throw new CoreError('PATH_CONFLICT', 'ChangeSet has no planning receipt', 409);
    record.phase = 'canceled'; await this.save(record);this.unresolved.delete(record.job.id);
    if (toCompiled) {
      // Human Review saves its own cancellation receipt after the candidate is removed.
      await this.changesets.cancel(id);
    } else { await this.returnReviewed(record); await this.changesets.cancel(id); }
    return manifest;
  }
  async cancelForSource(source: string) {
    if (this.running) throw new CoreError('JOB_BUSY', 'Wait for the active Planner before canceling review', 409);
    for (const manifest of await this.readyForSource(source)) {
      this.guardExecution(manifest.id);
      const job = this.all().find(job => job.changeset_id === manifest.id); const record = job ? await this.read(job.id) : null;
      if (record && ['prepared','ready'].includes(record.phase)) throw new CoreError('PATH_CONFLICT', 'Resolve interrupted planning publication first', 409);
      await this.changesets.cancel(manifest.id);
      if (record) { record.phase = 'canceled'; await this.save(record); }
    }
  }
  async cancel(id: string) { if (this.active()?.id === id) { this.controller?.abort(); await this.running; } const job = this.get(id); if (!job) throw new CoreError('JOB_NOT_FOUND', 'Planner Job not found', 404); return job; }
  async wait() { await this.running; }
  async close() { this.stopping = true; this.controller?.abort(); await this.running; }
}
