import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { ChangeSetReviewSchema, type ChangeSetReview, type ChangeSetInspection, type Config } from '@engramweave/contracts';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { windowsAttributes } from '../files/windows.js';
import { readMarkdown, readVaultFile } from '../files/read.js';
import { resolveVaultDirectory } from '../files/paths.js';
import { listAllDrafts } from '../drafts/files.js';
import { CoreError } from '../errors.js';
import type { HumanReviewActions } from '../review/human.js';
import { ChangeSets } from './store.js';
import { changeSetId } from './paths.js';

export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const missing = (error: unknown) => error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND';
export async function receiptDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true });
  const info = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([directory]))[0]?.reparse)) throw new CoreError('CONFIG_ERROR', 'Unsafe receipt directory', 400);
  return Boolean(info);
}
const revision = (record: Omit<ChangeSetReview, 'revision'>) => hash(JSON.stringify(record));
/** Human choices are separate from the Agent manifest and have their own optimistic revision. */
export class ChangeSetReviews {
  private writing = false;
  private readonly directory: string;
  constructor(private readonly config: Config, private readonly sets: ChangeSets, private readonly human: HumanReviewActions,
    private readonly guard: (id: string) => void) { this.directory = path.join(config.data_dir, 'changeset-reviews'); }
  async read(id: string): Promise<ChangeSetReview> {
    this.guard(id);
    const { manifest, revision: manifest_revision } = await this.sets.read(id);
    const bytes = await receiptDirectory(this.directory) ? await regularRead(path.join(this.directory, `${changeSetId(id)}.json`), 64000) : null;
    if (bytes) {
      let record: ChangeSetReview;
      try { record = JSON.parse(bytes.toString()); } catch { throw new CoreError('CONFIG_ERROR', 'Unreadable human decisions', 400); }
      const { revision: stored, ...input } = record;
      if (!Value.Check(ChangeSetReviewSchema, record) || stored !== revision(input) || record.changeset_id !== id) throw new CoreError('CONFIG_ERROR', 'Invalid human decisions', 400);
      if (record.manifest_revision !== manifest_revision) throw new CoreError('SOURCE_CHANGED', 'ChangeSet manifest changed; decisions require inspection', 409);
      return record;
    }
    const input = { changeset_id: id, manifest_revision, decisions: manifest.items.map(item => ({ item_id: item.id, decision: 'undecided' as const, domain_approved: false })) };
    return { ...input, revision: revision(input) };
  }
  async save(input: ChangeSetReview) {
    if (this.writing) throw new CoreError('JOB_BUSY', 'Human choices are being saved', 409);
    this.writing = true;
    try {
      if (this.sets.saving(input.changeset_id)) throw new CoreError('JOB_BUSY', 'ChangeSet approval is being accepted', 409);
      this.guard(input.changeset_id); const prior = await this.read(input.changeset_id);
      if (input.manifest_revision !== prior.manifest_revision || input.revision !== prior.revision) throw new CoreError('SOURCE_CHANGED', 'Human choices changed; reload before saving', 409);
      if (input.decisions.length !== prior.decisions.length || new Set(input.decisions.map(item => item.item_id)).size !== prior.decisions.length || input.decisions.some(item => !prior.decisions.some(entry => entry.item_id === item.item_id))) throw new CoreError('VALIDATION_ERROR', 'Every proposal needs exactly one choice', 400);
      const { revision: _, ...record } = input; const next = { ...record, revision: revision(record) };
      await receiptDirectory(this.directory, true); await atomicWrite(path.join(this.directory, `${input.changeset_id}.json`), JSON.stringify(next), 64000); return next;
    } finally { this.writing = false; }
  }
  async inspect(id: string): Promise<ChangeSetInspection> {
    const review = await this.read(id); const { manifest } = await this.sets.read(id);
    const related = await listAllDrafts(this.config.vault_path);
    if (related.diagnostics.length) throw new CoreError('INVALID_SOURCE', 'Unreadable Drafts prevent confirming related files', 422);
    const targets: ChangeSetInspection['targets'] = [];
    for (const item of manifest.items) {
      if (item.kind === 'write') { const document = await this.sets.candidate(id, item.id); targets.push({ item_id: item.id, current: document.current, current_revision: document.current_revision, candidate_revision: document.revision }); }
      else if (item.kind === 'directory') {
        let exists = false; try { await resolveVaultDirectory(this.config.vault_path, item.target); exists = true; } catch (error) { if (!missing(error)) throw error; }
        targets.push({ item_id: item.id, current: exists ? 'Directory already exists.' : null, current_revision: null, candidate_revision: null });
      } else { const file = await readVaultFile(this.config.vault_path, item.target); targets.push({ item_id: item.id, current: file.bytes.toString('utf8'), current_revision: file.revision, candidate_revision: null }); }
    }
    return { manifest_revision: review.manifest_revision, review, source_revision: (await readMarkdown(this.config.vault_path, manifest.source_path)).revision,
      selected_draft: await this.human.selection(manifest.source_path),
      related_drafts: related.items.filter(draft => draft.lifecycle_status === 'active' && draft.sources.some(source => source.toLowerCase() === manifest.source_path.toLowerCase())).map(draft => ({ path: draft.path, revision: draft.revision })), targets };
  }
}
