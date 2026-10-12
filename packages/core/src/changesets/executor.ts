import path from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { IntegrationJobSchema, ChangeSetApprovalSchema, LIMITS, type IntegrationJob, type ChangeSetApproval, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { readMarkdown, readVaultFile } from '../files/read.js';
import { resolveVaultDirectory, normalizeVaultPath } from '../files/paths.js';
import { PropertyNative } from '../files/property-native.js';
import { writeFormalFile, writeLifecycleProperties, recoverPropertyJournal, isPropertyJournal } from '../files/properties.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { parseMarkdown, parseMarkdownContent } from '../source/parse.js';
import { listAllDrafts, readDraft } from '../drafts/files.js';
import { resolveReference } from '../source/references.js';
import { updateCompiledSource, upsertLibraryDocument } from '../storage/registry.js';
import { sourceRelations } from '../storage/source-relations.js';
import type { HumanReviewActions } from '../review/human.js';
import { ChangeSets } from './store.js';
import { ChangeSetReviews, hash, missing, receiptDirectory } from './review.js';
import { changeSetId, formalPath } from './paths.js';

export interface ApprovedStep { kind: 'write' | 'directory' | 'discard'; path: string; before: string | null; after: string | null; bytes: string | null; done: boolean; staging_id?: string }
export interface ApprovedIntegration { source_path: string; source_revision: string; draft_path: string; related_drafts: { path: string; revision: string }[]; steps: ApprovedStep[] }
interface Receipt { version: 1; fingerprint: string; job: IntegrationJob; source_before: string; source_after: string; draft_path: string;
  steps: ApprovedStep[]; phase: 'applying' | 'consumed' | 'completed'; archived: boolean }
const bound = 64 * 1024 * 1024;
/** Accepted human bytes only. No inference or Agent tools are reachable from this executor. */
export class IntegrationExecutor {
  readonly reviews: ChangeSetReviews;
  private active = false; private completion: Promise<void> | null = null;
  private readonly pending = new Set<string>(); private readonly owned = new Map<string, string>();
  private acceptingId: string | null = null;
  private readonly directory: string;
  constructor(private readonly config: Config, private readonly db: Database.Database, readonly sets: ChangeSets,
    private readonly human: HumanReviewActions | undefined, private readonly otherBusy: () => boolean,
    private readonly revoke: (source: string, id: string) => Promise<void> = async () => {}) {
    this.directory = path.join(config.data_dir, 'integration-executions');
    this.reviews = new ChangeSetReviews(config, sets, human!, id => this.guard(id));
  }
  busy() { return this.active || this.pending.size > 0; }
  owns(id: string) { return this.owned.has(id); }
  accepting(id: string) { return this.acceptingId === id; }
  guard(id: string) { if (this.owns(id)) throw new CoreError('PATH_CONFLICT', 'This ChangeSet was accepted; inspect or retry its original execution instead', 409, { request_id: this.owned.get(id) }); }
  get(id: string): IntegrationJob | null { const row = this.db.prepare('SELECT job_json FROM integration_jobs WHERE id=?').get(id) as { job_json: string } | undefined; return row ? JSON.parse(row.job_json) : null; }
  all(): IntegrationJob[] { return (this.db.prepare('SELECT job_json FROM integration_jobs').all() as { job_json: string }[]).map(row => JSON.parse(row.job_json)); }
  current() { return this.all().find(job => job.status === 'running') ?? null; }
  private filename(id: string) { return path.join(this.directory, `${changeSetId(id)}.json`); }
  private async save(record: Receipt) {
    await receiptDirectory(this.directory, true); await atomicWrite(this.filename(record.job.id), JSON.stringify(record), bound);
    this.db.prepare('INSERT INTO integration_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET job_json=excluded.job_json').run(record.job.id, JSON.stringify(record.job));
    if (record.job.changeset_id) this.owned.set(record.job.changeset_id, record.job.id);
  }
  private async read(id: string): Promise<Receipt | null> {
    const bytes = await receiptDirectory(this.directory) ? await regularRead(this.filename(id), bound) : null;
    if (!bytes) return null;
    try {
      const record: Receipt = JSON.parse(bytes.toString());
      if (record.version !== 1 || record.job.id !== id || !Value.Check(IntegrationJobSchema, record.job) || !/^[a-f0-9]{64}$/.test(record.fingerprint)
        || !['applying','consumed','completed'].includes(record.phase) || !Array.isArray(record.steps) || record.steps.length > 100
        || !/^[a-f0-9]{64}$/.test(record.source_before) || !/^[a-f0-9]{64}$/.test(record.source_after) || typeof record.archived !== 'boolean'
        || !/^20_Sources\/.+\.md$/i.test(normalizeVaultPath(record.job.source_path)) || !/^30_Drafts\/.+\.md$/i.test(normalizeVaultPath(record.draft_path))) throw new Error();
      for (const draft of record.job.discarded_drafts) if (!/^30_Drafts\/.+\.md$/i.test(normalizeVaultPath(draft))) throw new Error();
      for (const step of record.steps) {
        formalPath(step.path, step.kind === 'directory');
        if (!['write','directory','discard'].includes(step.kind) || typeof step.done !== 'boolean' || step.before !== null && !/^[a-f0-9]{64}$/.test(step.before)
          || step.kind !== 'directory' && (typeof step.bytes !== 'string' || hash(Buffer.from(step.bytes, 'base64')) !== step.after)
          || step.staging_id !== undefined && (step.kind !== 'write' || step.before !== null || changeSetId(step.staging_id) !== step.staging_id)) throw new Error();
      }
      if (new Set(record.steps.map(step => step.path.toLowerCase())).size !== record.steps.length) throw new Error();
      return record;
    } catch { throw new CoreError('CONFIG_ERROR', 'Invalid accepted execution receipt; preserved for inspection', 400); }
  }
  async initialize() {
    if (!await receiptDirectory(this.directory)) return;
    const names = (await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    if (names.length > LIMITS.scan_candidates) throw new CoreError('CONFIG_ERROR', 'Execution history exceeds recovery bound', 400);
    for (const name of names) {
      const record = (await this.read(name.slice(0,-5)))!; await this.save(record);
      if (record.phase === 'completed') continue;
      this.pending.add(record.job.id); await this.resume(record);
    }
  }
  async lookup(id: string) { const record = await this.read(id); return { job: record?.job ?? null }; }
  async file(id: string, relative: string) {
    const record = await this.read(id); formalPath(relative);
    if (!record?.job.target_paths.includes(relative)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'File is not part of this accepted integration', 403);
    const file = await readVaultFile(this.config.vault_path, relative); return { path: relative, revision: file.revision };
  }
  async approve(request: ChangeSetApproval) {
    if (!Value.Check(ChangeSetApprovalSchema, request)) throw new CoreError('VALIDATION_ERROR', 'Invalid approval', 400);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])) : value;
    return this.submit(request.request_id, hash(JSON.stringify(canonical(request))), request.changeset_id, () => this.prepare(request), async () => {
      const { revision } = await this.sets.read(request.changeset_id); const inspection = await this.reviews.inspect(request.changeset_id);
      if (revision !== request.manifest_revision || inspection.review.revision !== request.review_revision || inspection.source_revision !== request.source_revision
        || inspection.selected_draft !== request.draft_path || request.items.some(item => !inspection.targets.some(target => target.item_id === item.item_id
          && target.current_revision === item.current_revision && target.candidate_revision === item.candidate_revision))) throw new CoreError('SOURCE_CHANGED', 'Approved inputs changed before the receipt was accepted', 409);
      const supplied = new Map(request.related_drafts.map(item => [item.path,item.revision]));
      if (inspection.related_drafts.length !== supplied.size || inspection.related_drafts.some(item => supplied.get(item.path) !== item.revision)) throw new CoreError('SOURCE_CHANGED', 'Related Drafts changed before acceptance', 409);
    });
  }
  /** The shortcut performs its existing one-approval validation, then uses this same receipt/apply/archive protocol. */
  async shortcut(id: string, fingerprint: string, prepare: () => Promise<ApprovedIntegration>) { return this.submit(id, fingerprint, null, prepare); }
  private async submit(id: string, fingerprint: string, changeset: string | null, prepare: () => Promise<ApprovedIntegration>, recheck?: () => Promise<void>) {
    if (this.active) throw new CoreError('JOB_BUSY', 'An accepted integration is running', 409);
    this.active = true; let complete!: () => void; this.completion = new Promise(resolve => { complete = resolve; });
    try {
      let record = await this.read(id); const reused = Boolean(record);
      if (record && record.fingerprint !== fingerprint) throw new CoreError('PATH_CONFLICT', 'Approval ID belongs to different input', 409);
      if (record?.phase === 'completed') return { job: record.job, reused: true };
      if (this.otherBusy() || [...this.pending].some(other => other !== id)) throw new CoreError('JOB_BUSY', 'Resolve the accepted execution before another workflow', 409);
      if (!record) {
        if (changeset) this.guard(changeset);
        this.acceptingId = changeset;
        const accept = async () => {
        const input = await prepare(); const source = await readMarkdown(this.config.vault_path, input.source_path);
        if (source.revision !== input.source_revision) throw new CoreError('SOURCE_CHANGED', 'Source changed before acceptance', 409);
        const now = new Date().toISOString();
        record = { version: 1, fingerprint, source_before: source.revision, source_after: hash(editScalarProperty(source.bytes, 'processing_status', 'archived')),
          draft_path: input.draft_path, steps: input.steps, phase: 'applying', archived: false,
          job: { id, kind: 'apply_integration', status: 'running', created_at: now, started_at: now, finished_at: null, source_path: input.source_path,
            changeset_id: changeset, target_paths: input.steps.map(step => step.path), completed_paths: [], discarded_drafts: input.related_drafts.map(draft => draft.path), error: null } };
        await this.preflight(record, true); await recheck?.(); await this.save(record); this.pending.add(id);
        };
        try { if (changeset) await this.sets.acceptance(changeset, accept); else await accept(); } finally { this.acceptingId = null; }
      }
      await this.resume(record!); return { job: record!.job, reused };
    } finally { this.active = false; complete(); this.completion = null; }
  }
  private async prepare(request: ChangeSetApproval): Promise<ApprovedIntegration> {
    const { manifest, revision } = await this.sets.read(request.changeset_id);
    const inspection = await this.reviews.inspect(manifest.id);
    if (manifest.state !== 'ready' || revision !== request.manifest_revision || inspection.review.revision !== request.review_revision
      || inspection.selected_draft !== request.draft_path || manifest.draft_path !== request.draft_path || inspection.source_revision !== request.source_revision) throw new CoreError('SOURCE_CHANGED', 'Review inputs changed; refresh and inspect before approving', 409);
    if (inspection.review.decisions.some(item => item.decision === 'undecided')) throw new CoreError('VALIDATION_ERROR', 'Decide every proposal before approval', 422);
    const accepted = manifest.items.filter(item => inspection.review.decisions.some(decision => decision.item_id === item.id && decision.decision === 'include'));
    if (accepted.length !== request.items.length || new Set(request.items.map(item => item.item_id)).size !== accepted.length) throw new CoreError('VALIDATION_ERROR', 'Approval must match the saved effective set', 422);
    for (const item of accepted) if (item.requires_domain_approval && !inspection.review.decisions.find(decision => decision.item_id === item.id)?.domain_approved) throw new CoreError('VALIDATION_ERROR', 'Explicit new-domain permission is required', 422, { path: item.target });
    const effective = { ...manifest, items: accepted }; await this.sets.validateContent(effective);
    const supplied = new Map(request.related_drafts.map(draft => [draft.path.toLowerCase(), draft.revision]));
    if (supplied.size !== request.related_drafts.length || supplied.size !== inspection.related_drafts.length || inspection.related_drafts.some(draft => supplied.get(draft.path.toLowerCase()) !== draft.revision)) throw new CoreError('SOURCE_CHANGED', 'Related Drafts changed; inspect again', 409);
    const steps: ApprovedStep[] = [];
    for (const item of accepted) {
      const approved = request.items.find(entry => entry.item_id === item.id)!; const current = inspection.targets.find(entry => entry.item_id === item.id)!;
      if (approved.current_revision !== current.current_revision || approved.candidate_revision !== current.candidate_revision) throw new CoreError('SOURCE_CHANGED', 'Current or Candidate changed since inspection', 409, { path: item.target });
      if (item.kind === 'directory') { steps.push({ kind: 'directory', path: item.target, before: null, after: null, bytes: null, done: false }); continue; }
      if ((item.before_revision === null) !== (current.current_revision === null)) throw new CoreError('SOURCE_CHANGED', 'Target creation or update condition changed', 409, { path: item.target });
      let bytes: Buffer;
      if (item.kind === 'write') {
        const document = await this.sets.candidate(manifest.id, item.id);
        if (document.revision !== approved.candidate_revision || document.current_revision !== approved.current_revision) throw new CoreError('SOURCE_CHANGED', 'Target changed during approval', 409);
        bytes = Buffer.from(document.content);
        // Only definite links to rejected, newly proposed files are checked. Existing unresolved Vault links remain valid user content.
        for (const match of document.content.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
          const reference = await resolveReference(this.config.vault_path, item.target, match[0], false);
          const rejected = manifest.items.find(entry => entry.kind === 'write' && entry.before_revision === null && !accepted.includes(entry)
            && reference.target_path && [entry.target, entry.target.replace(/\.md$/i, '')].some(target => target.toLowerCase() === reference.target_path!.toLowerCase()));
          if (rejected && reference.availability === 'missing') throw new CoreError('VALIDATION_ERROR', 'Candidate links to a rejected new file', 422, { path: item.target, dependency: rejected.target });
        }
      } else {
        bytes = Buffer.from(current.current!); if (parseMarkdownContent(item.target, bytes).state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Discard requires valid current Markdown', 422);
        bytes = editScalarProperty(bytes, 'lifecycle_status', 'discarded');
      }
      steps.push({ kind: item.kind as ApprovedStep['kind'], path: item.target, before: approved.current_revision, after: hash(bytes), bytes: bytes.toString('base64'), done: false });
    }
    // Known formal roots are fixed Vault scaffolding, not new-domain proposals.
    for (const root of new Set(steps.map(step => step.path.split('/')[0]!))) {
      try { await resolveVaultDirectory(this.config.vault_path, root); }
      catch (error) { if (!missing(error)) throw error; if (!steps.some(step => step.kind === 'directory' && step.path === root)) steps.unshift({ kind: 'directory', path: root, before: null, after: null, bytes: null, done: false }); }
    }
    return { source_path: manifest.source_path, source_revision: request.source_revision, draft_path: request.draft_path, related_drafts: request.related_drafts, steps };
  }
  private async recoverJournals(record: Receipt, native: PropertyNative) {
    for (const parent of new Set([...record.steps.filter(step => step.kind !== 'directory').map(step => path.posix.dirname(step.path)), path.posix.dirname(record.job.source_path), ...record.job.discarded_drafts.map(draft => path.posix.dirname(draft))])) {
      let directory: string; try { directory = await resolveVaultDirectory(this.config.vault_path, parent); } catch (error) { if (missing(error)) continue; throw error; }
      for (const name of (await readdir(directory)).filter(isPropertyJournal)) await recoverPropertyJournal(this.config.vault_path, parent, name, native);
    }
  }
  private async preflight(record: Receipt, accepting = false) {
    const native = new PropertyNative();
    try { await this.checkAll(record, native, accepting); } finally { await native.close(); }
  }
  private async checkAll(record: Receipt, native: PropertyNative, accepting: boolean) {
    for (const step of record.steps) {
      if (step.done) continue;
      if (step.kind === 'directory') { try { await resolveVaultDirectory(this.config.vault_path, step.path); } catch (error) { if (!missing(error)) throw error; } continue; }
      const file = await readVaultFile(this.config.vault_path, step.path).catch(error => { if (missing(error)) return null; throw error; });
      if ((file?.revision ?? null) !== step.before && (accepting || file?.revision !== step.after)) throw new CoreError('SOURCE_CHANGED', 'Approved target changed; restore the expected version before retrying this request', 409, { path: step.path });
      if (file) await native.checkFile(this.config.vault_path, step.path, file.revision);
      let parent = path.posix.dirname(step.path);
      while (parent !== '.') {
        try { await resolveVaultDirectory(this.config.vault_path, parent); }
        catch (error) { if (!missing(error)) throw error; if (!record.steps.some(entry => entry.kind === 'directory' && entry.path === parent)) throw new CoreError('PATH_CONFLICT', 'Required approved directory is missing', 409, { path: parent }); }
        parent = path.posix.dirname(parent);
      }
    }
    if (!record.archived) {
      const source = await readMarkdown(this.config.vault_path, record.job.source_path);
      if (![record.source_before, record.source_after].includes(source.revision)) throw new CoreError('SOURCE_CHANGED', 'Source changed after acceptance; execution is preserved', 409);
      await native.checkFile(this.config.vault_path, record.job.source_path, source.revision);
      const related = await listAllDrafts(this.config.vault_path);
      if (related.diagnostics.length || related.items.some(draft => draft.lifecycle_status === 'active' && draft.sources.some(source => source.toLowerCase() === record.job.source_path.toLowerCase()) && !record.job.discarded_drafts.includes(draft.path))) throw new CoreError('SOURCE_CHANGED', 'New related Drafts appeared after acceptance', 409);
      for (const relative of record.job.discarded_drafts) {
        const draft = await readDraft(this.config.vault_path, relative);
        await native.checkFile(this.config.vault_path, relative, draft.revision);
        if (draft.sources.length !== 1 || draft.sources[0]!.toLowerCase() !== record.job.source_path.toLowerCase()) throw new CoreError('SOURCE_CHANGED', 'An approved Draft was relinked', 409, { path: relative });
      }
    }
  }
  private async resume(record: Receipt) {
    try { record.job.status = 'running'; record.job.error = null; await this.save(record); await this.finish(record); }
    catch (error) { record.job.status = 'failed'; record.job.finished_at = new Date().toISOString(); record.job.error = { code: error instanceof CoreError ? error.code : 'IO_ERROR', message: error instanceof Error ? error.message : 'Execution failed', details: error instanceof CoreError ? error.details : null }; await this.save(record); }
  }
  private async finish(record: Receipt) {
    const vault = this.config.vault_path; const native = new PropertyNative();
    try {
      if (record.phase === 'applying') {
        await this.recoverJournals(record, native); await this.preflight(record);
        const ordered = [...record.steps].sort((a,b) => a.kind === 'directory' && b.kind === 'directory' ? a.path.length-b.path.length : a.kind === 'directory' ? -1 : b.kind === 'directory' ? 1 : 0);
        for (const step of ordered) {
          if (step.done) continue;
          if (step.kind === 'directory') await native.ensureFormalDirectory(vault, step.path);
          else {
            if (step.kind === 'write' && step.before === null && !step.staging_id) { step.staging_id = randomUUID(); await this.save(record); }
            const file = await readVaultFile(vault, step.path).catch(error => { if (missing(error)) return null; throw error; });
            if (file?.revision !== step.after) {
              if ((file?.revision ?? null) !== step.before) throw new CoreError('SOURCE_CHANGED', 'Approved target changed during execution', 409, { path: step.path });
              const bytes = Buffer.from(step.bytes!, 'base64');
              if (file) await writeFormalFile(vault, step.path, file, bytes, native); else await native.createFormal(vault, step.path, bytes, step.after!, step.staging_id);
            }
          }
          step.done = true; record.job.completed_paths.push(step.path); await this.save(record);
        }
        // Later user edits to a known, already-applied file are preserved and projected as current local content.
        for (const step of record.steps) if (step.kind !== 'directory' && !step.path.startsWith('60_Projects/')) {
          const file = await readVaultFile(vault, step.path).catch(error => { if (missing(error)) throw new CoreError('SOURCE_CHANGED', 'An applied target was removed or replaced; it will not be recreated', 409, { path: step.path }); throw error; }); upsertLibraryDocument(this.db, step.path, file, parseMarkdownContent(step.path, file.bytes));
        }
        if (!record.archived) {
          await this.preflight(record);
          for (const relative of record.job.discarded_drafts) {
            const file = await readMarkdown(vault, relative); const draft = await readDraft(vault, relative);
            if (draft.revision !== file.revision || draft.sources.length !== 1 || draft.sources[0]!.toLowerCase() !== record.job.source_path.toLowerCase()) throw new CoreError('SOURCE_CHANGED', 'Draft changed linkage during archival', 409);
            const bytes = editScalarProperty(file.bytes, 'lifecycle_status', 'discarded');
            if (!file.bytes.equals(bytes)) await writeLifecycleProperties(vault, relative, file, bytes, native);
          }
          const source = await readMarkdown(vault, record.job.source_path);
          if (source.revision !== record.source_after) {
            if (source.revision !== record.source_before) throw new CoreError('SOURCE_CHANGED', 'Source changed before archive', 409);
            await writeLifecycleProperties(vault, record.job.source_path, source, editScalarProperty(source.bytes, 'processing_status', 'archived'), native);
          }
          record.archived = true; await this.save(record);
        }
        const source = await readMarkdown(vault, record.job.source_path); updateCompiledSource(this.db, record.job.source_path, source, parseMarkdown(record.job.source_path, source.bytes));
        sourceRelations(this.db, vault).invalidate(); await this.revoke(record.job.source_path, record.job.id);
        record.phase = 'consumed'; await this.save(record);
      }
      if (record.job.changeset_id) {
        try { await this.sets.cancel(record.job.changeset_id, true); } catch (error) { if (!missing(error)) throw error; }
        const review = path.join(this.config.data_dir, 'changeset-reviews', `${record.job.changeset_id}.json`);
        if (await regularRead(review, 64000)) await unlink(review);
      }
      record.phase = 'completed'; record.steps = []; record.job.status = 'succeeded'; record.job.error = null; record.job.finished_at = new Date().toISOString();
      await this.save(record); this.pending.delete(record.job.id);
    } finally { await native.close(); }
  }
  async close() { await this.completion; }
}
