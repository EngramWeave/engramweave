import type Database from 'better-sqlite3';
import { LIMITS, type CompileRequest, type CompilerJob, type CompilerResult, type CompilerSettings, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { compilerInput, compilerResult } from '../compiler/input.js';
import { loadCompilerTemplate } from '../compiler/template.js';
import { getDocument, updateCompiledSource } from '../storage/registry.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown } from '../source/parse.js';
import { DraftPublisher } from '../drafts/files.js';
import { ExecutionSettings, localEndpoint } from '../execution/settings.js';
import { executeApi } from '../execution/api.js';
import { executeCodex } from '../execution/codex.js';

type Row = Omit<CompilerJob, 'kind' | 'prompt_version' | 'error'> & { error_json: string | null };
const asJob = (row: Row): CompilerJob => { const { error_json, ...rest } = row; return { ...rest, kind: 'compile_source', prompt_version: 'compiler-v1', error: error_json ? JSON.parse(error_json) : null }; };
const safeError = (error: unknown) => error instanceof CoreError ? { code: error.code, message: error.message, details: null } : { code: 'EXECUTION_FAILED' as const, message: 'Compiler execution or publication failed; inspect preserved files', details: null };
export type CompilerExecutor = (settings: CompilerSettings, prompt: string, signal: AbortSignal, instructions: string) => Promise<CompilerResult>;

export class CompilerJobs {
  readonly settings: ExecutionSettings;
  readonly publisher: DraftPublisher;
  private running: Promise<void> | null = null;
  private stopping = false;
  private submitting = false;
  private controller: AbortController | null = null;
  constructor(private readonly db: Database.Database, private readonly config: Config, private readonly scanActive: () => boolean, private readonly executor?: CompilerExecutor) {
    this.settings = new ExecutionSettings(config.data_dir);
    this.publisher = new DraftPublisher(config);
  }
  async initialize() {
    this.db.prepare("UPDATE compiler_jobs SET status='interrupted',finished_at=?,error_json=? WHERE status IN ('queued','running')").run(new Date().toISOString(), JSON.stringify({ code: 'EXECUTION_FAILED', message: 'Core exited before Compiler completed', details: null }));
    await this.publisher.initialize();
    for (const record of await this.publisher.pending()) {
      this.db.prepare("INSERT OR IGNORE INTO compiler_jobs(id,source_path,source_revision,route,model,status,created_at) VALUES(?,?,?,?,?,'interrupted',?)").run(record.id, record.source, record.before, record.route, record.model, record.created_at);
      try {
        const draft = await this.publisher.finish(record);
        // Missing/corrupt DB recovery never loses the already generated file result.
        const file = await readMarkdown(this.config.vault_path, record.source);
        if (file.revision === record.after) updateCompiledSource(this.db, record.source, file, parseMarkdown(record.source, file.bytes));
        this.db.prepare("UPDATE compiler_jobs SET status='succeeded',finished_at=?,draft_path=?,error_json=NULL WHERE id=?").run(new Date().toISOString(), draft, record.id);
        await this.publisher.complete(record.id);
      } catch (error) {
        this.db.prepare("UPDATE compiler_jobs SET status='failed',finished_at=?,error_json=? WHERE id=?").run(new Date().toISOString(), JSON.stringify(safeError(error)), record.id);
        if (error instanceof CoreError && error.code === 'SOURCE_CHANGED') await this.publisher.complete(record.id);
        // Uncertain publication is fail-closed; its files remain for explicit inspection.
      }
    }
    this.retain();
  }
  get(id: string) { const row = this.db.prepare('SELECT * FROM compiler_jobs WHERE id=?').get(id) as Row | undefined; return row ? asJob(row) : undefined; }
  active(): CompilerJob | null { const row = this.db.prepare("SELECT * FROM compiler_jobs WHERE status IN ('queued','running')").get() as Row | undefined; return row ? asJob(row) : null; }
  all() { return (this.db.prepare('SELECT * FROM compiler_jobs ORDER BY created_at DESC,id').all() as Row[]).map(asJob); }
  private retain() { this.db.prepare("DELETE FROM compiler_jobs WHERE id IN (SELECT id FROM compiler_jobs WHERE status NOT IN ('queued','running') ORDER BY created_at DESC,id LIMIT -1 OFFSET ?)").run(LIMITS.retained_finished_jobs); }
  async submit(input: CompileRequest) {
    if (this.stopping || this.submitting || this.scanActive()) throw new CoreError('JOB_BUSY', 'Core is scanning, stopping or accepting another Compiler request', 409);
    this.submitting = true;
    try {
      const previous = this.get(input.request_id);
      if (previous) {
        if (previous.source_path !== input.path || previous.source_revision !== input.revision) throw new CoreError('PATH_CONFLICT', 'Compilation request ID was already used for different input', 409);
        return { job: previous, reused: true };
      }
      if (this.active()) throw new CoreError('JOB_BUSY', 'Another Compiler task is active', 409);
      try {
        await readMarkdown(this.config.vault_path, `30_Drafts/${input.request_id}.md`);
        throw new CoreError('PATH_CONFLICT', 'This request already has a retained Draft; inspect it instead of rerunning', 409);
      } catch (error) {
        if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error;
      }
      if (getDocument(this.db, input.path)?.state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Scan and register this Source before compilation', 422);
      if ((await this.publisher.pending()).some(item => item.source.toLowerCase() === input.path.toLowerCase())) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'An unfinished publication for this Source requires inspection', 409);
      const { instructions } = await loadCompilerTemplate(this.config.vault_path);
      const { prompt } = await compilerInput(this.config.vault_path, input.path, input.revision);
      const { settings } = await this.settings.read();
      if (!settings.model.trim()) throw new CoreError('CONFIG_ERROR', 'Configure a Compiler model', 400);
      if (settings.route === 'api' && (!settings.endpoint.trim() || (!localEndpoint(settings.endpoint) && !(await this.settings.read()).api_key_configured))) throw new CoreError('CONFIG_ERROR', 'Configure API endpoint and credential', 400);
      if (settings.route === 'codex' && !settings.codex_path) throw new CoreError('CONFIG_ERROR', 'Configure a Codex executable path', 400);
      this.db.prepare("INSERT INTO compiler_jobs(id,source_path,source_revision,route,model,status,created_at) VALUES(?,?,?,?,?,'queued',?)").run(input.request_id, input.path, input.revision, settings.route, settings.model, new Date().toISOString());
      this.controller = new AbortController();
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(settings.timeout_seconds * 1000)]);
      this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(input, prompt, settings, signal, instructions));
      void this.running.catch(() => {});
      return { job: this.get(input.request_id)!, reused: false };
    } finally { this.submitting = false; }
  }
  busy() { return this.submitting || this.active() !== null; }
  private async execute(input: CompileRequest, prompt: string, settings: CompilerSettings, signal: AbortSignal, instructions: string) {
    try {
      this.db.prepare("UPDATE compiler_jobs SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), input.request_id);
      const result = this.executor ? await this.executor(settings, prompt, signal, instructions) : settings.route === 'api'
        ? await executeApi(settings, await this.settings.apiKey(settings.endpoint), prompt, signal, instructions) : await executeCodex(settings, this.config.data_dir, prompt, signal, instructions);
      if (signal.aborted) throw new CoreError('EXECUTION_FAILED', 'Compiler was stopped before publication');
      const record = await this.publisher.prepare(input.request_id, input.path, input.revision, compilerResult(JSON.stringify(result)), { route: settings.route === 'api' ? 'api' : 'codex', model: settings.model });
      const draft = await this.publisher.finish(record);
      const file = await readMarkdown(this.config.vault_path, input.path);
      const parsed = parseMarkdown(input.path, file.bytes);
      if (file.revision === record.after) updateCompiledSource(this.db, input.path, file, parsed);
      this.db.prepare("UPDATE compiler_jobs SET status='succeeded',finished_at=?,draft_path=?,error_json=NULL WHERE id=?").run(new Date().toISOString(), draft, input.request_id);
      await this.publisher.complete(input.request_id);
    } catch (error) {
      this.db.prepare("UPDATE compiler_jobs SET status=?,finished_at=?,error_json=? WHERE id=?").run(this.stopping ? 'interrupted' : 'failed', new Date().toISOString(), JSON.stringify(safeError(error)), input.request_id);
      if (error instanceof CoreError && error.code === 'SOURCE_CHANGED') await this.publisher.complete(input.request_id).catch(() => {});
    } finally { this.controller = null; this.retain(); }
  }
  async close() { this.stopping = true; this.controller?.abort(); await this.running; }
  async wait() { await this.running; }
}
