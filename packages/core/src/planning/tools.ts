import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ChangeSetEvidenceSchema, type ChangeSetItem, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { ChangeSets } from '../changesets/store.js';
import { formalPath } from '../changesets/paths.js';
import { readVaultFile } from '../files/read.js';
import { excludedName, resolveVaultDirectory, resolveVaultFile } from '../files/paths.js';
import type { SemanticRecall } from '../recall/index.js';
import type { PlanningSnapshot } from './input.js';

const string = Type.String({ minLength: 1, maxLength: 2048 });
const revision = Type.String({ pattern: '^[a-f0-9]{64}$' });
const object = (props: Record<string, TSchema>) => Type.Object(props, { additionalProperties: false });
const evidence = Type.Optional(Type.Array(ChangeSetEvidenceSchema, { maxItems: 40 }));
const reason = Type.String({ minLength: 1, maxLength: 8000 });
const define = (name: string, description: string, inputSchema: TSchema, readOnly: boolean) => ({ name, description, inputSchema,
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } });
export const plannerTools = [
  define('read_input', 'Read frozen Source, selected Draft, its Intent and unapproved Relation reference for this round.', object({}), true),
  define('recall', 'Retrieve current Knowledge/Ideas/Research passages with versions and coverage.', object({ q: Type.String({ minLength: 1, maxLength: 2000 }) }), true),
  define('read_note', 'Read full formal Markdown and Properties with its exact revision before proposing changes.', object({ path: string }), true),
  define('list_folders', 'List a bounded page of immediate formal directories/files, never the entire Vault.', object({ path: string, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }), true),
  define('read_candidate', 'Read a proposed target and its current candidate revision before editing.', object({ target: string }), true),
  define('write_file', 'Propose final Markdown only in this workspace, preserving Properties and Source provenance. Existing candidate rewrites require revision.', object({ target: string, content: Type.String({ minLength: 1, maxLength: 5 * 1024 * 1024 }), reason, evidence, revision: Type.Optional(revision) }), false),
  define('edit_file', 'Replace exactly one unique fragment of a candidate at the required revision, never formal content.', object({ target: string, revision, find: Type.String({ minLength: 1 }), replace: Type.String(), reason, evidence }), false),
  define('propose_structure', 'Propose a directory or lifecycle discard, without creating formal directories or deleting anything.', object({ kind: Type.Union([Type.Literal('directory'), Type.Literal('discard')]), target: string, reason, evidence }), false),
  define('validate_changeset', 'Inspect current proposal entries and completeness; Core publishes after successful Agent completion.', object({}), true),
];
type Evidence = ChangeSetItem['evidence'][number];
export class PlanningTools {
  readonly observations: { tool: string; arguments: unknown; result: unknown }[] = [];
  private calls = 0; private bytes = 0;
  private readonly delivered = new Map<string, Evidence[]>();
  private readonly notes = new Map<string, { content: string; revision: string }>();
  constructor(readonly snapshot: PlanningSnapshot, readonly changesetId: string, private readonly config: Config, private readonly store: ChangeSets,
    private readonly recall: Pick<SemanticRecall, 'recall' | 'context'>, private readonly signal: AbortSignal) {
    for (const input of [snapshot.source, snapshot.draft]) this.deliver({ path: input.path, revision: input.revision, start_line: 1, end_line: input.content.split(/\r?\n/).length });
  }
  private deliver(item: Evidence) {
    const previous = this.delivered.get(item.path.toLowerCase()) ?? [];
    if (previous.some(known => known.revision !== item.revision)) throw new CoreError('SOURCE_CHANGED', 'Evidence changed within the planning round', 409);
    this.delivered.set(item.path.toLowerCase(), [...previous, item]);
  }
  private citations(input?: Evidence[]) {
    const source = this.snapshot.source;
    const result = input?.length ? input : [{ path: source.path, revision: source.revision, start_line: 1, end_line: source.content.split(/\r?\n/).length }];
    for (const item of result) if (!(this.delivered.get(item.path.toLowerCase()) ?? []).some(known => known.revision === item.revision && known.start_line <= item.start_line && item.end_line <= known.end_line)) {
      throw new CoreError('INVALID_MODEL_OUTPUT', 'Evidence was not delivered in this round', 422);
    }
    return result;
  }
  async call(name: string, input: unknown): Promise<unknown> {
    this.signal.throwIfAborted(); const tool = plannerTools.find(tool => tool.name === name);
    if (!tool || !Value.Check(tool.inputSchema, input)) throw new CoreError('VALIDATION_ERROR', 'Tool or arguments outside Planner capability', 400);
    if (++this.calls > 64) throw new CoreError('PAYLOAD_TOO_LARGE', 'Planner tool budget reached', 413);
    const args = input as Record<string, unknown>; let result: unknown;
    if (name === 'read_input') result = { changeset_id: this.changesetId, ...this.snapshot };
    else if (name === 'recall') {
      const found = await this.recall.recall({ q: args.q as string, scope: 'all', limit: 12 }, this.signal); const verified = await this.recall.context(found.items);
      for (const item of verified.items) this.deliver(item);
      result = { ...found, items: verified.items, truncated: verified.truncated, diagnostics: [...found.diagnostics, ...verified.diagnostics] };
    } else if (name === 'read_note') {
      const target = formalPath(args.path as string); const file = await readVaultFile(this.config.vault_path, target);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
      this.deliver({ path: target, revision: file.revision, start_line: 1, end_line: content.split(/\r?\n/).length });
      this.notes.set(target.toLowerCase(), { content, revision: file.revision }); result = { path: target, content, revision: file.revision, start_line: 1, end_line: content.split(/\r?\n/).length };
    } else if (name === 'list_folders') {
      const target = formalPath(args.path as string, true); const directory = await resolveVaultDirectory(this.config.vault_path, target);
      const entries = (await readdir(directory, { withFileTypes: true })).filter(item => !excludedName(item.name) && !item.isSymbolicLink()).sort((a,b) => a.name.localeCompare(b.name));
      const offset = args.offset as number ?? 0; const items = [];
      for (const entry of entries.slice(offset, offset + 100)) {
        if (!entry.isDirectory() && (!entry.isFile() || !/\.md$/i.test(entry.name))) continue;
        const child = `${target}/${entry.name}`; if (entry.isDirectory()) await resolveVaultDirectory(this.config.vault_path, child); else await resolveVaultFile(this.config.vault_path, child);
        items.push({ path: child, kind: entry.isDirectory() ? 'directory' : 'file' });
      }
      result = { items, next_offset: offset + 100 < entries.length ? offset + 100 : null };
    } else if (name === 'validate_changeset') {
      result = await this.store.inspect(this.changesetId);
    } else result = await this.proposal(name, args);
    const size = Buffer.byteLength(JSON.stringify(result)); this.bytes += size;
    if (this.bytes > 16 * 1024 * 1024) throw new CoreError('PAYLOAD_TOO_LARGE', 'Planner context output budget reached', 413);
    this.signal.throwIfAborted();
    const observed = { ...args }; for (const key of ['content','find','replace']) if (typeof observed[key] === 'string') observed[key] = { bytes: Buffer.byteLength(observed[key] as string), hash: createHash('sha256').update(observed[key] as string).digest('hex') };
    const summary = result as Record<string, unknown>;
    this.observations.push({ tool: name, arguments: observed, result: { bytes: size, path: summary.path ?? null, revision: summary.revision ?? null,
      items: Array.isArray(summary.items) ? summary.items.map(item => ({ path: item.path, revision: item.revision, start_line: item.start_line, end_line: item.end_line })) : undefined, item: summary.item ?? undefined } });
    return result;
  }
  private async proposal(name: string, args: Record<string, unknown>) {
    const target = formalPath(args.target as string, name === 'propose_structure' && args.kind === 'directory');
    const { manifest } = await this.store.read(this.changesetId); const existing = manifest.items.find(item => item.target.toLowerCase() === target.toLowerCase());
    if (name === 'read_candidate' || name === 'edit_file') {
      if (!existing) throw new CoreError('DOCUMENT_NOT_FOUND', 'Propose this target before reading/editing its candidate', 404);
      const candidate = await this.store.candidate(this.changesetId, existing.id);
      if (name === 'read_candidate') return { target, content: candidate.content, revision: candidate.revision };
      const find = args.find as string;
      if (candidate.revision !== args.revision || candidate.content.split(find).length !== 2) throw new CoreError('SOURCE_CHANGED', 'Candidate revision or exact fragment does not match', 409);
      const item = await this.store.propose(this.changesetId, { ...existing, reason: args.reason as string, evidence: this.citations(args.evidence as Evidence[] | undefined) }, candidate.content.replace(find, args.replace as string), candidate.revision);
      return { item, revision: (await this.store.candidate(this.changesetId, item.id)).revision };
    }
    const kind = name === 'write_file' ? 'write' : args.kind as 'directory' | 'discard'; const note = this.notes.get(target.toLowerCase());
    if (kind !== 'directory' && !note) {
      try { await readVaultFile(this.config.vault_path, target); throw new CoreError('INVALID_MODEL_OUTPUT', 'Read the full existing note before proposing replacement or discard', 422); }
      catch (error) { if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error; if (kind === 'discard') throw error; }
    }
    let newDirectory=false;
    if(kind==='directory')try{await resolveVaultDirectory(this.config.vault_path,target);}catch(error){if(!(error instanceof CoreError&&error.code==='DOCUMENT_NOT_FOUND'))throw error;newDirectory=true;}
    const item = await this.store.propose(this.changesetId, { kind, target, before_revision: note?.revision ?? null, reason: args.reason as string,
      evidence: this.citations(args.evidence as Evidence[] | undefined), requires_domain_approval: newDirectory && target.split('/').length === 2 },
      name === 'write_file' ? args.content as string : undefined, args.revision as string | undefined);
    return name === 'write_file' ? { item, revision: (await this.store.candidate(this.changesetId, item.id)).revision } : { item };
  }
}
