import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { LIMITS, PublishDraftRequestSchema, type Config, type PublishDraftRequest, type PublishDraftResponse } from '@engramweave/contracts';
import type Database from 'better-sqlite3';
import { CoreError } from '../errors.js';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { readMarkdown } from '../files/read.js';
import { markdownPath, resolveVaultDirectory } from '../files/paths.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { writeLifecycleProperties, recoverPropertyJournal, isPropertyJournal } from '../files/properties.js';
import { PropertyNative } from '../files/property-native.js';
import { windowsAttributes } from '../files/windows.js';
import { publishFile } from '../files/publication.js';
import { listAllDrafts, parseDraft } from '../drafts/files.js';
import { parseMarkdown } from '../source/parse.js';
import { sourceRelations } from '../storage/source-relations.js';
import { updateCompiledSource, upsertLibraryDocument } from '../storage/registry.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const samePath = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxRecordBytes = 8 * 1024 * 1024;
interface Edit { path: string; before: string; after: string }
interface Receipt {
  version: 1; request: PublishDraftRequest; target_revision: string; knowledge_bytes: string;
  edits: Edit[]; phase: 'prepared' | 'created' | 'completed'; error: string | null;
}
/** One explicit human approval, one new note. Receipts survive database reconstruction. */
export class DraftPublications {
  private active = false;
  private completion: Promise<void> | null = null;
  private unfinished = new Set<string>();
  private readonly byDraft = new Map<string, { request: PublishDraftRequest; status: 'completed' | 'unfinished'; error: string | null }>();
  private readonly directory: string;
  constructor(private readonly config: Config, private readonly db: Database.Database, private readonly otherBusy: () => boolean,
    private readonly analysis: (id: string) => { draft_path: string; source_path: string; status: string } | undefined) {
    this.directory = path.join(config.data_dir, 'draft-publications');
  }
  busy() { return this.active || this.unfinished.size > 0; }
  async close() { await this.completion; }
  private filename(id: string) {
    if (!idPattern.test(id)) throw new CoreError('VALIDATION_ERROR', 'Invalid publication request ID', 400);
    return path.join(this.directory, `${id}.json`);
  }
  private async directoryReady(create = false) {
    if (create) await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([this.directory]))[0]?.reparse) throw new CoreError('CONFIG_ERROR', 'Publication receipt directory is unsafe', 400);
    return true;
  }
  private async save(record: Receipt) {
    await this.directoryReady(true);
    await atomicWrite(this.filename(record.request.request_id), JSON.stringify(record), maxRecordBytes);
    this.remember(record);
  }
  private remember(record: Receipt) { this.byDraft.set(record.request.draft_path, { request: record.request, status: record.phase === 'completed' ? 'completed' : 'unfinished', error: record.error }); }
  private async read(id: string): Promise<Receipt | null> {
    if (!await this.directoryReady()) return null;
    const bytes = await regularRead(this.filename(id), maxRecordBytes);
    if (!bytes) return null;
    try {
      const record: Receipt = JSON.parse(bytes.toString());
      if (record.version !== 1 || !Value.Check(PublishDraftRequestSchema, record.request) || record.request.request_id !== id
        || !['prepared','created','completed'].includes(record.phase) || typeof record.knowledge_bytes !== 'string'
        || digest(Buffer.from(record.knowledge_bytes, 'base64')) !== record.target_revision || !Array.isArray(record.edits)
        || record.edits.length !== record.request.related_drafts.length + 1) throw new Error();
      markdownPath(record.request.target_path);
      const expected = [...record.request.related_drafts.map(item => item.path), record.request.source_path];
      record.edits.forEach((edit, index) => {
        if (edit.path !== expected[index] || !/^[a-f0-9]{64}$/.test(edit.before) || !/^[a-f0-9]{64}$/.test(edit.after)) throw new Error();
        markdownPath(edit.path, true);
      });
      if (new Set(expected.map(item => item.toLowerCase())).size !== expected.length) throw new Error();
      return record;
    } catch { throw new CoreError('CONFIG_ERROR', 'Publication receipt is invalid; preserved for inspection', 400); }
  }
  async initialize() {
    if (!await this.directoryReady()) return;
    const ids = (await readdir(this.directory)).filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5))).map(name => name.slice(0, -5));
    if (ids.length > LIMITS.scan_candidates) throw new CoreError('CONFIG_ERROR', 'Publication history exceeds recovery bound', 400);
    for (const id of ids) {
      const record = (await this.read(id))!;
      this.remember(record);
      if (record.phase === 'completed') continue;
      this.unfinished.add(id);
      try { await this.finish(record); }
      catch (error) { record.error = error instanceof CoreError ? error.message : 'Publication recovery failed; retry the original approval after resolving the conflict'; await this.save(record); }
    }
  }
  async forDraft(draftPath: string) {
    return this.byDraft.get(draftPath) ?? null;
  }
  async submit(request: PublishDraftRequest): Promise<PublishDraftResponse> {
    if (this.active) throw new CoreError('JOB_BUSY', 'An approved Draft publication is active', 409);
    this.active = true;
    let completed!: () => void;
    this.completion = new Promise(resolve => { completed = resolve; });
    try { return await this.accept(request); }
    finally { this.active = false; completed(); this.completion = null; }
  }
  private async accept(request: PublishDraftRequest): Promise<PublishDraftResponse> {
    const prior = await this.read(request.request_id);
    if (prior && !isDeepStrictEqual(prior.request, request)) throw new CoreError('PATH_CONFLICT', 'Publication request ID was reused with different input', 409);
    if (prior?.phase === 'completed') return this.response(prior, true);
    if (this.otherBusy() || [...this.unfinished].some(id => id !== request.request_id)) throw new CoreError('JOB_BUSY', 'Resolve the unfinished publication or wait for the active operation', 409);
    let record = prior;
    try {
      if (!record) { record = await this.prepare(request); await this.save(record); this.unfinished.add(request.request_id); }
      await this.finish(record);
      return this.response(record, Boolean(prior));
    } catch (error) {
      if (record) { record.error = error instanceof CoreError ? error.message : 'Publication failed; retry this approval to resume safely'; await this.save(record); }
      throw error;
    }
  }
  private response(record: Receipt, reused: boolean): PublishDraftResponse {
    return { request_id: record.request.request_id, target_path: record.request.target_path, source_path: record.request.source_path,
      discarded_drafts: record.request.related_drafts.map(item => item.path), status: 'completed', reused };
  }
  private async prepare(request: PublishDraftRequest): Promise<Receipt> {
    markdownPath(request.target_path);
    if (!request.target_path.startsWith('40_Knowledge/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'MVP publication creates only Knowledge notes', 403);
    const source = await readMarkdown(this.config.vault_path, request.source_path);
    const parsed = parseMarkdown(request.source_path, source.bytes);
    const draftFile = await readMarkdown(this.config.vault_path, request.draft_path);
    const draft = parseDraft(request.draft_path, draftFile);
    if (source.revision !== request.source_revision || draft.revision !== request.draft_revision) throw new CoreError('SOURCE_CHANGED', 'Source or Draft changed; inspect current content before approving again', 409);
    if (parsed.state !== 'ready' || parsed.lifecycle_status !== 'active' || !['compiled','reviewed'].includes(parsed.processing_status ?? '')
      || draft.lifecycle_status !== 'active' || draft.sources.length !== 1 || !samePath(draft.sources[0]!, request.source_path)) throw new CoreError('INVALID_SOURCE', 'MVP publication requires one active Draft and its compiled or reviewed Source', 422);
    const job = this.analysis(request.analysis_id);
    if (!job || job.draft_path !== request.draft_path || job.source_path !== request.source_path || ['queued','running'].includes(job.status)) throw new CoreError('JOB_BUSY', 'Finish a Draft Analyzer attempt before Human Review; failed attempts also permit review', 409);
    const related = await listAllDrafts(this.config.vault_path);
    if (related.diagnostics.length) throw new CoreError('INVALID_SOURCE', 'Unreadable Drafts prevent confirming the complete cleanup list', 422, { diagnostics: related.diagnostics });
    const targets = related.items.filter(item => item.lifecycle_status === 'active' && item.sources.some(source => samePath(source, request.source_path)));
    const selected = new Map(request.related_drafts.map(item => [item.path.toLowerCase(), item.revision]));
    if (selected.size !== request.related_drafts.length || targets.length !== selected.size || targets.some(item => selected.get(item.path.toLowerCase()) !== item.revision)) throw new CoreError('SOURCE_CHANGED', 'Related Drafts changed; inspect the cleanup list again', 409);
    // Sharing a candidate with another submission needs a separate product contract.
    if (targets.some(item => item.sources.length !== 1)) throw new CoreError('INVALID_SOURCE', 'MVP publication does not consume Drafts shared by multiple Sources', 422);
    await mkdir(path.join(this.config.vault_path, '40_Knowledge')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await resolveVaultDirectory(this.config.vault_path, path.posix.dirname(request.target_path));
    const existing = await readMarkdown(this.config.vault_path, request.target_path).catch(error => { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; });
    if (existing) throw new CoreError('PATH_CONFLICT', 'Knowledge target already exists; choose a different filename', 409);
    const edits: Edit[] = [];
    for (const item of request.related_drafts) {
      const file = await readMarkdown(this.config.vault_path, item.path);
      if (file.revision !== item.revision) throw new CoreError('SOURCE_CHANGED', 'A related Draft changed before approval was accepted', 409);
      edits.push({ path: item.path, before: file.revision, after: digest(editScalarProperty(file.bytes, 'lifecycle_status', 'discarded')) });
    }
    edits.push({ path: request.source_path, before: source.revision, after: digest(editScalarProperty(source.bytes, 'processing_status', 'archived')) });
    const bytes = editScalarProperty(editScalarProperty(editScalarProperty(draftFile.bytes, 'type', 'knowledge'), 'lifecycle_status', 'active'), 'mvp_publication_id', request.request_id, true);
    if (parseMarkdown(request.target_path, bytes).state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Draft Properties cannot be published as Knowledge', 422);
    return { version: 1, request, target_revision: digest(bytes), knowledge_bytes: bytes.toString('base64'), edits, phase: 'prepared', error: null };
  }
  private async finish(record: Receipt) {
    const vault = this.config.vault_path;
    const native = new PropertyNative();
    try {
      for (const parent of new Set(record.edits.map(edit => path.posix.dirname(edit.path)))) {
        for (const name of (await readdir(await resolveVaultDirectory(vault, parent))).filter(isPropertyJournal)) await recoverPropertyJournal(vault, parent, name, native);
      }
      // Check every approved mutation before publication or another recovery step.
      for (const edit of record.edits) {
        const file = await readMarkdown(vault, edit.path);
        if (![edit.before, edit.after].includes(file.revision)) throw new CoreError('SOURCE_CHANGED', 'An approved file changed; preserved publication requires conflict resolution', 409, { path: edit.path });
      }
      const related = await listAllDrafts(vault);
      if (related.diagnostics.length || related.items.some(draft => draft.lifecycle_status === 'active' && draft.sources.some(source => samePath(source, record.request.source_path))
        && !record.request.related_drafts.some(item => samePath(item.path, draft.path)))) throw new CoreError('SOURCE_CHANGED', 'Related Drafts changed after approval; preserve the unfinished publication for inspection', 409);
      let target = await readMarkdown(vault, record.request.target_path).catch(error => { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; });
      if (record.phase === 'prepared') {
        if (target && target.revision !== record.target_revision) throw new CoreError('PATH_CONFLICT', 'Knowledge target changed before publication was confirmed', 409);
        if (!target) {
          if (!await publishFile(vault, record.request.target_path, Buffer.from(record.knowledge_bytes, 'base64'))) throw new CoreError('PATH_CONFLICT', 'Knowledge target appeared during publication', 409);
          target = await readMarkdown(vault, record.request.target_path);
        }
        record.phase = 'created'; await this.save(record);
      }
      if (!target || parseMarkdown(record.request.target_path, target.bytes).metadata.mvp_publication_id !== record.request.request_id) throw new CoreError('SOURCE_CHANGED', 'Published Knowledge was removed or replaced; it will not be recreated or overwritten', 409);
      for (const edit of record.edits) {
        const file = await readMarkdown(vault, edit.path);
        if (file.revision === edit.after) continue;
        if (file.revision !== edit.before) throw new CoreError('SOURCE_CHANGED', 'An approved file changed during publication', 409, { path: edit.path });
        const isSource = edit.path === record.request.source_path;
        const bytes = editScalarProperty(file.bytes, isSource ? 'processing_status' : 'lifecycle_status', isSource ? 'archived' : 'discarded');
        if (digest(bytes) !== edit.after) throw new CoreError('SOURCE_CHANGED', 'Recovery edit no longer matches the approved file', 409);
        await writeLifecycleProperties(vault, edit.path, file, bytes, native);
      }
      const source = await readMarkdown(vault, record.request.source_path);
      updateCompiledSource(this.db, record.request.source_path, source, parseMarkdown(record.request.source_path, source.bytes));
      upsertLibraryDocument(this.db, record.request.target_path, target, parseMarkdown(record.request.target_path, target.bytes));
      sourceRelations(this.db, vault).invalidate();
      record.phase = 'completed'; record.error = null; await this.save(record);
      this.unfinished.delete(record.request.request_id);
    } finally { await native.close(); }
  }
}
