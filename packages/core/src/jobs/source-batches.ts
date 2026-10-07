import { lstat, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SourceBatchSchema, SourceBatchRequestSchema, type Config, type SourceBatch, type SourceBatchRequest } from '@engramweave/contracts';
import type Database from 'better-sqlite3';
import { CoreError } from '../errors.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown, stringList } from '../source/parse.js';
import { resolveDocumentReferences } from '../source/references.js';
import { readDraft, listDrafts } from '../drafts/files.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { PropertyNative } from '../files/property-native.js';
import { writeLifecycleProperties, isPropertyJournal, recoverPropertyJournal } from '../files/properties.js';
import { resolveVaultDirectory } from '../files/paths.js';
import { allDocuments, updateCompiledSource } from '../storage/registry.js';
import type { CompilerJobs } from './compiler.js';

type Target = { path: string; revision: string };
export class SourceBatches {
  private current: SourceBatch | null = null;
  private input: SourceBatchRequest | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private readonly filename: string;
  constructor(private readonly config: Config, private readonly db: Database.Database, private readonly compiler: CompilerJobs, private readonly scanBusy: () => boolean) {
    this.filename = path.join(config.data_dir, 'source-batch.json');
  }
  async initialize() {
    const info = await lstat(this.filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2_000_000) throw new CoreError('CONFIG_ERROR', 'Batch record is unsafe');
    const saved = JSON.parse(await readFile(this.filename, 'utf8'));
    if (!Value.Check(SourceBatchSchema, saved.result) || !Value.Check(SourceBatchRequestSchema, saved.input)) throw new CoreError('CONFIG_ERROR', 'Batch record is invalid');
    this.current = saved.result; this.input = saved.input;
    // Recover only property journals in the explicitly recorded target directories. Never rerun models.
    const native = new PropertyNative();
    try {
      const directories = new Set(this.input!.items.flatMap(item => [item.path, ...(item.related?.map(target => target.path) ?? [])]).map(relative => path.posix.dirname(relative)));
      for (const directory of directories) {
        const absolute = await resolveVaultDirectory(this.config.vault_path, directory).catch(error => { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; });
        if (!absolute) continue;
        const journals = (await readdir(absolute)).filter(isPropertyJournal);
        if (journals.length > 100) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Too many interrupted lifecycle writes');
        for (const name of journals) await recoverPropertyJournal(this.config.vault_path, directory, name, native);
      }
    } finally { await native.close(); }
    if (this.current!.status === 'running') {
      this.current!.status = 'interrupted';
      for (const item of this.current!.items) if (['pending', 'running'].includes(item.status)) { item.status = 'skipped'; item.error = { code: 'CORE_UNAVAILABLE', message: 'Core stopped; inspect existing files before starting a new batch' }; }
      await this.save();
    }
  }
  busy() { return this.current?.status === 'running'; }
  latest() { return this.current; }
  get(id: string) { if (this.current?.id !== id) throw new CoreError('JOB_NOT_FOUND', 'Batch result is no longer retained', 404); return this.current; }
  private async save() {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const info = await lstat(this.filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new CoreError('CONFIG_ERROR', 'Batch record identity is unsafe');
    await writeFile(temporary, JSON.stringify({ input: this.input, result: this.current }), { flag: 'wx', flush: true, mode: 0o600 });
    await rename(temporary, this.filename);
  }
  async preview(relative: string) {
    if (!relative.startsWith('20_Sources/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Lifecycle actions require a Source', 403);
    const file = await readMarkdown(this.config.vault_path, relative);
    const parsed = parseMarkdown(relative, file.bytes);
    if (parsed.state !== 'ready') throw new CoreError('INVALID_SOURCE', 'An unreadable Source cannot be safely discarded', 422);
    const drafts = parsed.processing_status === 'archived' ? [] : (await listDrafts(this.config.vault_path, relative)).items.map(item => ({ path: item.path, revision: item.revision }));
    const references: Target[] = [];
    for (const row of allDocuments(this.db).filter(row => row.kind === 'knowledge' && row.state === 'ready')) {
      const current = await readMarkdown(this.config.vault_path, row.path);
      const knowledge = parseMarkdown(row.path, current.bytes);
      if (knowledge.state !== 'ready' || knowledge.lifecycle_status !== 'active') continue;
      if ((await resolveDocumentReferences(this.config.vault_path, row.path, knowledge)).some(reference => reference.target_path?.toLowerCase() === relative.toLowerCase())) references.push({ path: row.path, revision: current.revision });
    }
    return { source: { path: relative, revision: file.revision }, drafts, references };
  }
  async submit(input: SourceBatchRequest) {
    if (this.current?.id === input.id) {
      if (JSON.stringify(input) !== JSON.stringify(this.input)) throw new CoreError('PATH_CONFLICT', 'Batch ID already belongs to different targets', 409);
      return this.current;
    }
    if (this.stopping || this.busy() || this.compiler.busy() || this.scanBusy()) throw new CoreError('JOB_BUSY', 'Wait for the active Core operation before starting a batch', 409);
    if (new Set(input.items.map(item => item.path.toLowerCase())).size !== input.items.length || input.items.some(item => !item.path.startsWith('20_Sources/'))) throw new CoreError('VALIDATION_ERROR', 'Select distinct Source paths', 400);
    this.input = input;
    this.current = { id: input.id, action: input.action, status: 'running', items: input.items.map(item => ({ path: item.path, status: 'pending', job_id: null, error: null })) };
    await this.save();
    this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute());
    void this.running.catch(() => {});
    return this.current;
  }
  private async mark(target: Target, status: 'active' | 'discarded', native: PropertyNative) {
    const file = await readMarkdown(this.config.vault_path, target.path);
    if (file.revision !== target.revision) throw new CoreError('SOURCE_CHANGED', 'Lifecycle target changed; preview and select it again', 409);
    if (target.path.startsWith('30_Drafts/')) await readDraft(this.config.vault_path, target.path);
    else if (parseMarkdown(target.path, file.bytes).state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Lifecycle target is not readable', 422);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    const updated = /^---\r?\n/.test(text) ? editScalarProperty(file.bytes, 'lifecycle_status', status) : Buffer.from(`---\nlifecycle_status: ${status}\n---\n${text}`);
    if (!file.bytes.equals(updated)) await writeLifecycleProperties(this.config.vault_path, target.path, file, updated, native);
    if (!target.path.startsWith('30_Drafts/')) {
      const current = await readMarkdown(this.config.vault_path, target.path);
      updateCompiledSource(this.db, target.path, current, parseMarkdown(target.path, current.bytes));
    }
  }
  private async execute() {
    const input = this.input!, result = this.current!, native = new PropertyNative();
    const marked = new Map<string, string>();
    try {
      for (const [index, item] of input.items.entries()) {
        const outcome = result.items[index]!;
        if (this.stopping) { outcome.status = 'skipped'; outcome.error = { code: 'CORE_UNAVAILABLE', message: 'Core is stopping; this item was not started' }; continue; }
        outcome.status = 'running'; await this.save();
        try {
          const current = await readMarkdown(this.config.vault_path, item.path);
          if (current.revision !== item.revision) throw new CoreError('SOURCE_CHANGED', 'Source changed since selection', 409);
          const parsed = parseMarkdown(item.path, current.bytes);
          if (parsed.state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Source is not available', 422);
          if (input.action === 'compile') {
            const accepted = await this.compiler.submit({ path: item.path, revision: item.revision, request_id: item.request_id });
            outcome.job_id = accepted.job.id; await this.save(); await this.compiler.wait();
            const job = this.compiler.get(accepted.job.id)!;
            if (job.status !== 'succeeded') throw new CoreError('EXECUTION_FAILED', job.error?.message ?? 'Compiler did not complete');
          } else {
            if (input.action === 'discard') {
              const preview = await this.preview(item.path);
              const selected = item.related ?? [];
              const selectedPaths = new Set(selected.map(target => target.path.toLowerCase()));
              if (preview.drafts.some(target => !marked.has(target.path.toLowerCase()) && !selected.some(choice => choice.path === target.path && choice.revision === target.revision))) throw new CoreError('SOURCE_CHANGED', 'Related Drafts changed; preview Discard again', 409);
              if (selected.some(target => !marked.has(target.path.toLowerCase()) && ![...preview.drafts, ...preview.references].some(choice => choice.path === target.path && choice.revision === target.revision))) throw new CoreError('PATH_CONFLICT', 'Related target is outside the current Discard preview', 409);
              if (selectedPaths.size !== selected.length) throw new CoreError('VALIDATION_ERROR', 'Duplicate related Discard target', 400);
              // Verify all selected revisions before the first write for this item.
              for (const target of selected) if ((await readMarkdown(this.config.vault_path, target.path)).revision !== (marked.get(target.path.toLowerCase()) ?? target.revision)) throw new CoreError('SOURCE_CHANGED', 'Related target changed', 409);
              for (const target of selected) if (!marked.has(target.path.toLowerCase())) { await this.mark(target, 'discarded', native); marked.set(target.path.toLowerCase(), (await readMarkdown(this.config.vault_path, target.path)).revision); }
            }
            await this.mark(item, input.action === 'restore' ? 'active' : 'discarded', native);
          }
          outcome.status = 'succeeded';
        } catch (error) {
          outcome.status = error instanceof CoreError && ['INVALID_SOURCE', 'SOURCE_CHANGED', 'PATH_CONFLICT'].includes(error.code) ? 'skipped' : 'failed';
          outcome.error = error instanceof CoreError ? { code: error.code, message: error.message } : { code: 'IO_ERROR', message: 'Operation failed; inspect preserved files and retry explicitly' };
        }
        await this.save();
      }
      result.status = this.stopping ? 'interrupted' : 'completed'; await this.save();
    } finally { await native.close(); }
  }
  async close() { this.stopping = true; await this.running; }
}
