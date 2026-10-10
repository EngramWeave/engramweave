import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { HumanReviewRequestSchema, type Config, type HumanReviewRequest, type HumanReviewResponse, type HumanReviewContext, type ReviewActionReceipt } from '@engramweave/contracts';
import type Database from 'better-sqlite3';
import { CoreError } from '../errors.js';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { readMarkdown } from '../files/read.js';
import { readDraft } from '../drafts/files.js';
import { parseMarkdown } from '../source/parse.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { PropertyNative } from '../files/property-native.js';
import { recoverPropertyJournal, isPropertyJournal, writeSourceProperties } from '../files/properties.js';
import { resolveVaultDirectory, markdownPath } from '../files/paths.js';
import { windowsAttributes } from '../files/windows.js';
import { publishFile } from '../files/publication.js';
import { updateCompiledSource, upsertLibraryDocument } from '../storage/registry.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const key = (relative: string) => relative.toLowerCase();
interface Receipt { version: 1; sequence: number; request: HumanReviewRequest; source_bytes: string | null; after: string | null;
  idea: { path: string; bytes: string; revision: string } | null; completed: boolean }
interface Revocation { version: 1; sequence: number; source_path: string; draft_path: string | null }

/** Accepted human input is authoritative outside SQLite; selection is separate from each Draft's Intent. */
export class HumanReviewActions {
  private active = false;
  private stopping = false;
  private completion: Promise<void> | null = null;
  private sequence = 0;
  private readonly unfinished = new Set<string>();
  private readonly intents = new Map<string, string>();
  private readonly selected = new Map<string, string>();
  private readonly sourcePaths = new Map<string, string>();
  private readonly directory: string;
  constructor(private readonly config: Config, private readonly db: Database.Database, private readonly otherBusy: () => boolean,
    private readonly otherAccepted: (id: string) => Promise<boolean> = async () => false) { this.directory = path.join(config.data_dir, 'human-review'); }
  busy() { return this.active || this.unfinished.size > 0; }
  async close() { this.stopping = true; await this.completion; }
  private file(id: string, revoke = false) {
    if (!uuid.test(id)) throw new CoreError('VALIDATION_ERROR', 'Invalid human action ID', 400);
    return path.join(this.directory, `${id}${revoke ? '.revoke' : ''}.json`);
  }
  private async ready(create = false) {
    if (create) await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([this.directory]))[0]?.reparse) throw new CoreError('CONFIG_ERROR', 'Human Review storage is unsafe', 400);
    return true;
  }
  private async save(record: Receipt) { await this.ready(true); await atomicWrite(this.file(record.request.request_id), JSON.stringify(record), 8_000_000); }
  private async read(id: string): Promise<Receipt | null> {
    if (!await this.ready()) return null;
    const bytes = await regularRead(this.file(id), 8_000_000); if (!bytes) return null;
    try {
      const record: Receipt = JSON.parse(bytes.toString());
      if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !Value.Check(HumanReviewRequestSchema, record.request)
        || record.request.request_id !== id || typeof record.completed !== 'boolean') throw new Error();
      markdownPath(record.request.source_path); markdownPath(record.request.draft_path, true);
      if (record.request.action === 'idea') {
        if (record.source_bytes !== null || record.after !== null || !record.idea || record.idea.path !== `10_Ideas/${id}.md`
          || typeof record.idea.bytes !== 'string' || hash(Buffer.from(record.idea.bytes, 'base64')) !== record.idea.revision) throw new Error();
      } else if (record.idea !== null || typeof record.source_bytes !== 'string' || hash(Buffer.from(record.source_bytes, 'base64')) !== record.after) throw new Error();
      return record;
    } catch { throw new CoreError('CONFIG_ERROR', 'Human Review receipt is invalid; preserved for inspection', 400); }
  }
  private remember(record: Receipt) {
    if (!record.completed) return;
    const request = record.request;
    if (request.action === 'complete') { this.intents.set(key(request.draft_path), request.note); this.selected.set(key(request.source_path), request.draft_path); this.sourcePaths.set(key(request.source_path), request.source_path); }
    if (request.action === 'cancel') this.selected.delete(key(request.source_path));
  }
  async initialize() {
    if (!await this.ready()) return;
    const names = await readdir(this.directory);
    if (names.filter(name => name.endsWith('.json')).length > 10000) throw new CoreError('CONFIG_ERROR', 'Human Review history exceeds its recovery bound', 400);
    const events: (Receipt | Revocation)[] = [];
    for (const name of names) {
      if (/^[0-9a-f-]+\.revoke\.json$/.test(name) && uuid.test(name.slice(0, -12))) {
        const value: Revocation = JSON.parse((await regularRead(path.join(this.directory, name), 16384))!.toString());
        if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.source_path !== 'string'
          || !value.source_path.startsWith('20_Sources/') || value.draft_path !== null && (typeof value.draft_path !== 'string' || !value.draft_path.startsWith('30_Drafts/'))) throw new CoreError('CONFIG_ERROR', 'Human Review revocation is invalid', 400);
        markdownPath(value.source_path); if (value.draft_path) markdownPath(value.draft_path, true); events.push(value);
      } else if (name.endsWith('.json') && uuid.test(name.slice(0,-5))) events.push((await this.read(name.slice(0,-5)))!);
    }
    events.sort((a,b) => a.sequence - b.sequence);
    if (new Set(events.map(event => event.sequence)).size !== events.length) throw new CoreError('CONFIG_ERROR', 'Human Review receipt ordering is ambiguous', 400);
    this.sequence = events.at(-1)?.sequence ?? 0;
    for (const event of events) {
      if (!('request' in event)) { this.applyRevocation(event); continue; }
      if (!event.completed) { this.unfinished.add(event.request.request_id); try { await this.finish(event); } catch { /* Preserve accepted input and block competing writes until resolved. */ } }
      this.remember(event);
    }
    // Reconcile lifecycle writes interrupted before their revocation callback, before allowing Restore.
    for (const [sourceKey, draft] of [...this.selected]) { const source = this.sourcePaths.get(sourceKey)!; if (!await this.permissionValid(source, draft)) await this.revoke(source, draft); }
  }
  private applyRevocation(event: Revocation) {
    if (event.draft_path === null || key(this.selected.get(key(event.source_path)) ?? '') === key(event.draft_path)) this.selected.delete(key(event.source_path));
  }
  async revoke(source: string, draft: string | null = null, id?: string) {
    if (draft && key(this.selected.get(key(source)) ?? '') !== key(draft) || !this.selected.has(key(source))) return;
    const filename = this.file(id ?? randomUUID(), true); await this.ready(true);
    const prior = await regularRead(filename, 16384);
    if (prior) return; // An old deterministic revocation cannot withdraw a newer explicit selection.
    const event: Revocation = { version: 1, sequence: ++this.sequence, source_path: source, draft_path: draft };
    await atomicWrite(filename, JSON.stringify(event), 16384); this.applyRevocation(event);
  }
  private async permissionValid(source: string, draft: string) {
    try {
      const parsed = parseMarkdown(source, (await readMarkdown(this.config.vault_path, source)).bytes);
      const selected = await readDraft(this.config.vault_path, draft);
      return parsed.state === 'ready' && parsed.lifecycle_status === 'active' && parsed.processing_status === 'reviewed'
        && selected.lifecycle_status === 'active' && selected.sources.length === 1 && key(selected.sources[0]!) === key(source);
    } catch { return false; }
  }
  async context(source: string, draft: string): Promise<HumanReviewContext> {
    const selected = this.selected.get(key(source));
    return { selected_draft: selected && await this.permissionValid(source, selected) ? selected : null, intent: this.intents.get(key(draft)) ?? null };
  }
  private response(record: Receipt, reused: boolean): HumanReviewResponse { return { request_id: record.request.request_id, action: record.request.action, status: 'completed', idea_path: record.idea?.path ?? null, reused }; }
  async receipt(id: string): Promise<ReviewActionReceipt> {
    const record = await this.read(id);
    if (!record) return { status: 'not_found', request: null, result: null };
    return record.completed ? { status: 'completed', request: record.request, result: this.response(record,true) }
      : { status: 'unfinished', request: record.request, result: null };
  }
  async submit(request: HumanReviewRequest): Promise<HumanReviewResponse> {
    if (this.active || this.stopping) throw new CoreError('JOB_BUSY', 'Human Review is being saved or Core is stopping', 409);
    this.active = true; let release!: () => void; this.completion = new Promise(resolve => { release = resolve; });
    try {
      let record = await this.read(request.request_id); const reused = Boolean(record);
      if (record && !isDeepStrictEqual(record.request, request)) throw new CoreError('PATH_CONFLICT', 'Human action ID belongs to different input', 409);
      if (record?.completed) return this.response(record, true);
      if (!record && await this.otherAccepted(request.request_id)) throw new CoreError('PATH_CONFLICT', 'Review action ID already belongs to Recompile input', 409);
      if (this.otherBusy() || [...this.unfinished].some(id => id !== request.request_id)) throw new CoreError('JOB_BUSY', 'Wait for the active operation or resolve unfinished Human Review', 409);
      if (!record) { record = await this.prepare(request); await this.save(record); this.unfinished.add(request.request_id); }
      await this.finish(record); this.remember(record); return this.response(record, reused);
    } finally { this.active = false; release(); this.completion = null; }
  }
  private async prepare(request: HumanReviewRequest): Promise<Receipt> {
    if (!Value.Check(HumanReviewRequestSchema, request)) throw new CoreError('VALIDATION_ERROR', 'Invalid Human Review request', 400);
    const source = await readMarkdown(this.config.vault_path, request.source_path); const parsed = parseMarkdown(request.source_path, source.bytes);
    const draft = await readDraft(this.config.vault_path, request.draft_path);
    if (source.revision !== request.source_revision || draft.revision !== request.draft_revision) throw new CoreError('SOURCE_CHANGED', 'Source or Draft changed; inspect current files before submitting', 409);
    if (parsed.state !== 'ready' || parsed.lifecycle_status !== 'active' || !(request.action === 'idea' ? ['pending','compiled','reviewed','planned'] : ['compiled','reviewed']).includes(parsed.processing_status ?? '')
      || draft.lifecycle_status !== 'active' || draft.sources.length !== 1 || key(draft.sources[0]!) !== key(request.source_path)) throw new CoreError('INVALID_SOURCE', 'Human Review requires an active Draft of its compiled or reviewed Source', 422);
    if (request.action === 'cancel' && (request.note !== '' || parsed.processing_status !== 'reviewed' || key(this.selected.get(key(request.source_path)) ?? '') !== key(draft.path))) throw new CoreError('PATH_CONFLICT', 'Cancel applies only to the current Reviewed Draft and consumes no input', 409);
    const record: Receipt = { version: 1, sequence: ++this.sequence, request, source_bytes: null, after: null, idea: null, completed: false };
    if (request.action === 'idea') {
      if (!request.note.trim()) throw new CoreError('VALIDATION_ERROR', 'Create Idea requires nonempty input', 400);
      await resolveVaultDirectory(this.config.vault_path, '');
      await mkdir(path.join(this.config.vault_path, '10_Ideas')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      await resolveVaultDirectory(this.config.vault_path, '10_Ideas');
      const bytes = Buffer.from(`---\ntype: idea\ntitle: ${JSON.stringify(request.note.split(/\r?\n/).find(line => line.trim())!.slice(0,120))}\nlifecycle_status: active\nsources: [${JSON.stringify(`[[${request.source_path}]]`)}]\ndrafts: [${JSON.stringify(`[[${request.draft_path}]]`)}]\nhuman_action_id: ${request.request_id}\n---\n${request.note}`);
      record.idea = { path: `10_Ideas/${request.request_id}.md`, bytes: bytes.toString('base64'), revision: hash(bytes) };
      const existing = await readMarkdown(this.config.vault_path, record.idea.path).catch(error => { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; });
      if (existing) throw new CoreError('PATH_CONFLICT', 'Idea target already exists; it will not be overwritten', 409);
    } else {
      const bytes = editScalarProperty(source.bytes, 'processing_status', request.action === 'complete' ? 'reviewed' : 'compiled');
      record.source_bytes = bytes.toString('base64'); record.after = hash(bytes);
    }
    return record;
  }
  private async finish(record: Receipt) {
    const request = record.request; const vault = this.config.vault_path;
    if (record.idea) {
      let target = await readMarkdown(vault, record.idea.path).catch(error => { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; });
      if (target && target.revision !== record.idea.revision) throw new CoreError('PATH_CONFLICT', 'Idea target changed; preserve accepted input and inspect the existing file', 409);
      if (!target) {
        if (!await publishFile(vault, record.idea.path, Buffer.from(record.idea.bytes,'base64'))) throw new CoreError('PATH_CONFLICT', 'Idea target appeared during creation', 409);
        target = await readMarkdown(vault, record.idea.path);
      }
      upsertLibraryDocument(this.db, record.idea.path, target, parseMarkdown(record.idea.path, target.bytes));
    } else {
      const native = new PropertyNative();
      try {
        const parent = path.posix.dirname(request.source_path);
        for (const name of (await readdir(await resolveVaultDirectory(vault, parent))).filter(isPropertyJournal)) await recoverPropertyJournal(vault, parent, name, native);
        const draft = await readDraft(vault, request.draft_path);
        if (draft.lifecycle_status !== 'active' || draft.sources.length !== 1 || key(draft.sources[0]!) !== key(request.source_path)) throw new CoreError('SOURCE_CHANGED', 'Accepted Draft was removed, discarded or relinked; inspect the preserved receipt', 409);
        let source = await readMarkdown(vault, request.source_path);
        if (![request.source_revision, record.after].includes(source.revision)) throw new CoreError('SOURCE_CHANGED', 'Source changed during Human Review; restore the accepted version before retrying', 409);
        if (source.revision !== record.after) source = await writeSourceProperties(vault, request.source_path, source, Buffer.from(record.source_bytes!,'base64'), native);
        updateCompiledSource(this.db, request.source_path, source, parseMarkdown(request.source_path, source.bytes));
      } finally { await native.close(); }
    }
    record.completed = true; await this.save(record); this.unfinished.delete(request.request_id);
  }
}
