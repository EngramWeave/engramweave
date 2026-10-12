import { lstat, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SourceBatchSchema, SourceBatchRequestSchema, type Config, type SourceBatch, type SourceBatchRequest } from '@engramweave/contracts';
import type Database from 'better-sqlite3';
import { CoreError } from '../errors.js';
import { readVaultFile, readMarkdown, type FileRead } from '../files/read.js';
import { parseMarkdown, parseMarkdownContent } from '../source/parse.js';
import { parseDraft } from '../drafts/files.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { PropertyNative } from '../files/property-native.js';
import { writeLifecycleProperties, isPropertyJournal, recoverPropertyJournal } from '../files/properties.js';
import { resolveMarkdown, resolveVaultDirectory } from '../files/paths.js';
import { getDocument, updateCompiledSource } from '../storage/registry.js';
import { sourceRelations } from '../storage/source-relations.js';
import type { CompilerJobs } from './compiler.js';
import { retainWindowsAttributes } from '../files/windows.js';

type Target = { path: string; revision: string };
type SourceTarget = { path: string; revision: string | null; source_missing?: boolean };
export class SourceBatches {
  private current: SourceBatch | null = null;
  private input: SourceBatchRequest | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private readonly filename: string;
  private readonly native = new PropertyNative();
  private readonly releaseAttributes = retainWindowsAttributes();
  constructor(private readonly config: Config, private readonly db: Database.Database, private readonly compiler: CompilerJobs, private readonly scanBusy: () => boolean,
    private readonly guardAnalysis: (input: SourceBatchRequest) => void = () => {},
    private readonly revokeReview: (target: string) => Promise<void> = async () => {}) {
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
  private async save(result = this.current) {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const info = await lstat(this.filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new CoreError('CONFIG_ERROR', 'Batch record identity is unsafe');
    await writeFile(temporary, JSON.stringify({ input: this.input, result }), { flag: 'wx', flush: true, mode: 0o600 });
    await rename(temporary, this.filename);
  }
  private async readSource(relative: string): Promise<FileRead | null> {
    if (!relative.startsWith('20_Sources/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Lifecycle actions require a Source', 403);
    try { return await readMarkdown(this.config.vault_path, relative); }
    catch (error) {
      if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // An unavailable Vault/root is not evidence that individual Records were deleted.
      await resolveVaultDirectory(this.config.vault_path, '20_Sources');
      try { await resolveMarkdown(this.config.vault_path, relative); }
      catch (missing) { if (missing instanceof CoreError && missing.code === 'DOCUMENT_NOT_FOUND') return null; throw missing; }
      throw new CoreError('SOURCE_CHANGED', 'Source changed during availability checks; preview again', 409);
    }
  }
  private async verifyMissing(target: SourceTarget) {
    if (!target.source_missing) throw new CoreError('SOURCE_CHANGED', 'Source is missing; preview the missing-record action again', 409);
    if (await this.readSource(target.path)) throw new CoreError('SOURCE_CHANGED', 'Source exists again; refresh and select it again', 409);
    const row = getDocument(this.db, target.path);
    if ((row && row.kind !== 'source') || (row?.revision ?? null) !== target.revision) throw new CoreError('SOURCE_CHANGED', 'Source registration changed; preview again', 409);
  }
  async preview(relative: string, snapshot = false, alreadyRead?: FileRead) {
    const file = alreadyRead ?? await this.readSource(relative);
    if (file && parseMarkdown(relative, file.bytes).state !== 'ready') throw new CoreError('INVALID_SOURCE', 'An unreadable Source cannot be safely discarded', 422);
    const row = file ? undefined : getDocument(this.db, relative);
    if (row && row.kind !== 'source') throw new CoreError('INVALID_SOURCE', 'Registration is not a Source', 422);
    const index = sourceRelations(this.db, this.config.vault_path);
    if (!snapshot) await index.refresh();
    const related = index.targets(relative);
    return { source: { path: relative, revision: file?.revision ?? row?.revision ?? null }, source_missing: file === null, drafts: related.drafts, references: related.references };
  }
  async submit(input: SourceBatchRequest) {
    if (this.current?.id === input.id) {
      if (JSON.stringify(input) !== JSON.stringify(this.input)) throw new CoreError('PATH_CONFLICT', 'Batch ID already belongs to different targets', 409);
      return this.current;
    }
    if (this.stopping || this.busy() || this.compiler.busy() || this.scanBusy()) throw new CoreError('JOB_BUSY', 'Wait for the active Core operation before starting a batch', 409);
    this.guardAnalysis(input);
    if (input.items.some(item => item.source_missing || item.revision === null) && !['discard','discard_drafts'].includes(input.action)) throw new CoreError('VALIDATION_ERROR', 'Missing Source targets only support Discard cleanup or Discard Drafts', 400);
    if (new Set(input.items.map(item => item.path.toLowerCase())).size !== input.items.length || input.items.some(item => !item.path.startsWith('20_Sources/'))) throw new CoreError('VALIDATION_ERROR', 'Select distinct Source paths', 400);
    this.input = input;
    this.current = { id: input.id, action: input.action, status: 'running', items: input.items.map(item => ({ path: item.path, status: 'pending', job_id: null, error: null })) };
    await this.save();
    this.running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute());
    void this.running.catch(() => {});
    return this.current;
  }
  private async mark(target: Target, status: 'active' | 'discarded', native: PropertyNative, alreadyRead: FileRead) {
    const file = alreadyRead;
    if (file.revision !== target.revision) throw new CoreError('SOURCE_CHANGED', 'Lifecycle target changed; preview and select it again', 409);
    if (target.path.startsWith('30_Drafts/')) parseDraft(target.path, file);
    else if (parseMarkdownContent(target.path, file.bytes).state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Lifecycle target is not readable', 422);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    let updated = /^---\r?\n/.test(text) ? editScalarProperty(file.bytes, 'lifecycle_status', status) : Buffer.from(`---\nlifecycle_status: ${status}\n---\n${text}`);
    if (status === 'active' && target.path.startsWith('20_Sources/')) updated = editScalarProperty(updated, 'processing_status', 'pending');
    const committed = file.bytes.equals(updated) ? file : await writeLifecycleProperties(this.config.vault_path, target.path, file, updated, native);
    if (!target.path.startsWith('30_Drafts/') && !target.path.startsWith('60_Projects/')) {
      updateCompiledSource(this.db, target.path, committed, parseMarkdown(target.path, committed.bytes));
    }
    if (status === 'discarded') { sourceRelations(this.db, this.config.vault_path).removed(target.path); await this.revokeReview(target.path); }
    return committed.revision;
  }
  private async discardRelated(item: SourceTarget & { related?: Target[] }, action: 'discard' | 'discard_drafts', preview: Awaited<ReturnType<SourceBatches['preview']>>, marked: Map<string,string>) {
    const selected = item.related ?? [];
    if (new Set(selected.map(target => target.path.toLowerCase())).size !== selected.length) throw new CoreError('VALIDATION_ERROR', 'Duplicate related Discard target', 400);
    if (action === 'discard' && preview.drafts.some(target => !marked.has(target.path.toLowerCase()) && !selected.some(choice => choice.path === target.path && choice.revision === target.revision))) throw new CoreError('SOURCE_CHANGED', 'Related Drafts changed; preview Discard again', 409);
    if (action === 'discard_drafts' && selected.some(target => !target.path.startsWith('30_Drafts/'))) throw new CoreError('PATH_CONFLICT', 'Discard Drafts cannot change Source or formal knowledge', 409);
    if (selected.some(target => !marked.has(target.path.toLowerCase()) && ![...preview.drafts,...preview.references].some(choice => choice.path === target.path && choice.revision === target.revision))) throw new CoreError('PATH_CONFLICT', 'Related target is outside the current Discard preview', 409);
    const files = new Map<string,FileRead>();
    for (const target of selected) {
      const file = target.path.startsWith('60_Projects/') ? await readVaultFile(this.config.vault_path,target.path) : await readMarkdown(this.config.vault_path,target.path);
      if (file.revision !== (marked.get(target.path.toLowerCase()) ?? target.revision)) throw new CoreError('SOURCE_CHANGED', 'Related target changed', 409);
      files.set(target.path,file);
    }
    if (item.source_missing) await this.verifyMissing(item);
    for (const target of selected) if (!marked.has(target.path.toLowerCase())) marked.set(target.path.toLowerCase(), await this.mark(target,'discarded',this.native,files.get(target.path)!));
  }
  private async execute() {
    const input = this.input!, result = this.current!, native = this.native;
    const marked = new Map<string, string>();
    try {
      const relations = sourceRelations(this.db, this.config.vault_path);
      if (input.action === 'delete' || input.action === 'discard_drafts' || input.action === 'discard' && !input.items.every(item => item.source_missing)) await relations.refresh(true, input.action === 'delete');
      for (const [index, item] of input.items.entries()) {
        const outcome = result.items[index]!;
        if (this.stopping) { outcome.status = 'skipped'; outcome.error = { code: 'CORE_UNAVAILABLE', message: 'Core is stopping; this item was not started' }; continue; }
        outcome.status = 'running'; await this.save();
        try {
          const current = await this.readSource(item.path);
          if (!current) {
            await this.verifyMissing(item);
            if (input.action === 'discard') {
              if (item.related?.length || item.allow_referenced || item.reference_revisions?.length) throw new CoreError('VALIDATION_ERROR', 'Missing-record cleanup cannot modify related files', 400);
              this.db.transaction(() => {
                this.db.prepare("DELETE FROM documents WHERE path_key=? AND kind='source'").run(item.path.toLowerCase());
                this.db.prepare('UPDATE meta SET index_generation=index_generation+1 WHERE id=1').run();
              })();
            } else if (input.action === 'discard_drafts') {
              const preview = await this.preview(item.path,true);
              if (!preview.source_missing) throw new CoreError('SOURCE_CHANGED', 'Source exists again; preview again', 409);
              await this.discardRelated(item,'discard_drafts',preview,marked);
              this.db.prepare('UPDATE meta SET index_generation=index_generation+1 WHERE id=1').run();
            } else throw new CoreError('INVALID_SOURCE', 'Missing Source cannot run this action', 422);
            outcome.status = 'succeeded'; await this.save(); continue;
          }
          if (item.source_missing) throw new CoreError('SOURCE_CHANGED', 'Source exists again; refresh and select it again', 409);
          if (current.revision !== item.revision) throw new CoreError('SOURCE_CHANGED', 'Source changed since selection', 409);
          const parsed = parseMarkdown(item.path, current.bytes);
          if (parsed.state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Source is not available', 422);
          if (input.action === 'compile') {
            const accepted = await this.compiler.submit({ path: item.path, revision: current.revision, request_id: item.request_id });
            outcome.job_id = accepted.job.id; await this.save(); await this.compiler.wait();
            const job = this.compiler.get(accepted.job.id)!;
            if (job.status !== 'succeeded') throw new CoreError('EXECUTION_FAILED', job.error?.message ?? 'Compiler did not complete');
          } else if (input.action === 'delete') {
            if (parsed.lifecycle_status !== 'discarded') throw new CoreError('PATH_CONFLICT', 'Only discarded Sources can be permanently deleted', 409);
            const related = relations.targets(item.path);
            if (related.diagnostics.some(item => item.code === 'REFERENCE_UNREADABLE')) throw new CoreError('PATH_CONFLICT', 'Formal references could not be verified; refresh and inspect before deleting', 409);
            if (related.references.length && !item.allow_referenced) throw new CoreError('PATH_CONFLICT', 'Active formal knowledge still references this Source; explicit reference confirmation is required', 409);
            if (related.references.some(reference => !item.reference_revisions?.some(approved => approved.path === reference.path && approved.revision === reference.revision))) throw new CoreError('SOURCE_CHANGED', 'Formal reference list changed after confirmation; preview deletion again', 409);
            if (item.related?.length) throw new CoreError('VALIDATION_ERROR', 'Source deletion does not delete related Draft or formal files', 400);
            // Inline captures have no separate owned Asset. Unproven/shared assets are preserved.
            await native.remove(this.config.vault_path, item.path, current.revision);
            this.db.transaction(() => {
              this.db.prepare('DELETE FROM documents WHERE path_key=?').run(item.path.toLowerCase());
              this.db.prepare('UPDATE meta SET index_generation=index_generation+1 WHERE id=1').run();
            })();
            relations.invalidate();
          } else {
            if (input.action === 'restore' && parsed.lifecycle_status !== 'discarded') throw new CoreError('PATH_CONFLICT', 'Restore requires a discarded Source', 409);
            if (input.action === 'discard' || input.action === 'discard_drafts') {
              if (parsed.lifecycle_status !== 'active') throw new CoreError('PATH_CONFLICT', 'Select active Sources for Discard actions', 409);
              const preview = await this.preview(item.path, true, current);
              if (input.action === 'discard' && parsed.processing_status === 'archived') preview.drafts = [];
              await this.discardRelated(item,input.action,preview,marked);
            }
            if (input.action === 'restore' && parsed.lifecycle_status === 'discarded') await this.revokeReview(item.path);
            if (input.action !== 'discard_drafts') await this.mark({path:item.path,revision:current.revision}, input.action === 'restore' ? 'active' : 'discarded', native, current);
            else this.db.prepare('UPDATE meta SET index_generation=index_generation+1 WHERE id=1').run();
          }
          outcome.status = 'succeeded';
        } catch (error) {
          outcome.status = error instanceof CoreError && ['INVALID_SOURCE', 'SOURCE_CHANGED', 'PATH_CONFLICT'].includes(error.code) ? 'skipped' : 'failed';
          outcome.error = error instanceof CoreError ? { code: error.code, message: error.message } : { code: 'IO_ERROR', message: 'Operation failed; inspect preserved files and retry explicitly' };
        }
        await this.save();
      }
      const status = this.stopping ? 'interrupted' : 'completed';
      // Publish completion only after its durable receipt; the next batch cannot race this save.
      await this.save({ ...result, status }); result.status = status;
    } catch (error) {
      for (const item of result.items) if (['pending', 'running'].includes(item.status)) { item.status = 'failed'; item.error = error instanceof CoreError ? { code: error.code, message: error.message } : { code: 'IO_ERROR', message: 'Batch preparation failed; no unfinished item was replayed' }; }
      await this.save({ ...result, status: 'completed' }); result.status = 'completed';
    } finally { sourceRelations(this.db, this.config.vault_path).invalidate(); }
  }
  async close() { this.stopping = true; try { await this.running; } finally { try { await this.native.close(); } finally { await this.releaseAttributes(); } } }
}
