import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { LIMITS, type Draft } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { listAllDrafts, readDraft } from '../drafts/files.js';
import { readMarkdown, readVaultFile } from '../files/read.js';
import { resolveMarkdown, resolveVaultFile } from '../files/paths.js';
import { parseMarkdownContent, type ParsedDocument } from '../source/parse.js';
import { resolveDocumentReferences } from '../source/references.js';
import { indexMeta } from './database.js';
import { enumerateMarkdown } from '../discovery/scan.js';
import { formalRoots } from '../changesets/paths.js';

type Contribution = { path: string; revision: string; kind: 'draft' | 'knowledge'; title: string; sources: string[] };
type Target = { path: string; revision: string; title: string; kind: 'draft' | 'knowledge' };
const indexes = new WeakMap<Database.Database, SourceRelations>();
const stamp = (info: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
/** Disposable per-file metadata and inverse link projection; mutation bytes are never served from this cache. */
export class SourceRelations {
  private pending: Promise<void> | null = null;
  private pendingDraftsOnly = false;
  private generation = -1;
  private expires = 0;
  private diagnostics: { code: string; message: string; path: string }[] = [];
  private draftDiagnostics: typeof this.diagnostics = [];
  private referenceDiagnostics: typeof this.diagnostics = [];
  private drafts = new Map<string, { stamp: string; draft: Draft }>();
  private knowledge = new Map<string, { stamp: string; revision: string; parsed: ParsedDocument }>();
  private contributions = new Map<string, string>();
  constructor(private readonly db: Database.Database, private readonly vault: string) {
    db.exec(`CREATE TEMP TABLE relation_files (path_key TEXT PRIMARY KEY, path TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL);
      CREATE TEMP TABLE source_relations (source_key TEXT NOT NULL, path_key TEXT NOT NULL, PRIMARY KEY(source_key,path_key));
      CREATE INDEX temp.source_relations_file ON source_relations(path_key);`);
  }
  async refreshDrafts() { await this.refresh(true, false, true); }
  async refresh(force = false, freshReferences = false, draftsOnly = false): Promise<void> {
    if (this.pending) { const pendingDraftsOnly = this.pendingDraftsOnly; await this.pending; if (freshReferences || !draftsOnly && pendingDraftsOnly) return this.refresh(true, freshReferences); return; }
    if (!force && this.generation === indexMeta(this.db).index_generation && Date.now() < this.expires) return;
    this.pendingDraftsOnly = draftsOnly;
    this.pending = this.reconcile(freshReferences, draftsOnly);
    try { await this.pending; } finally { this.pending = null; }
  }
  private async reconcile(freshReferences: boolean, draftsOnly: boolean) {
    const generation = indexMeta(this.db).index_generation;
    const draftPaths = new Set<string>();
    let draftBytes = 0;
    const drafts = await listAllDrafts(this.vault, async (vault, relative, checked) => {
      const key = relative.toLowerCase(); draftPaths.add(key);
      const info = await lstat(path.join(vault, relative));
      draftBytes += info.size;
      if (draftBytes > LIMITS.scan_total_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'Draft metadata cache exceeds the byte limit', 413);
      const observation = stamp(info);
      const cached = this.drafts.get(key);
      if (cached?.stamp === observation) {
        if (cached.draft.path !== relative) cached.draft = { ...cached.draft, path: relative };
        return cached.draft;
      }
      const draft = await readDraft(vault, relative, checked);
      this.drafts.set(key, { stamp: observation, draft }); return draft;
    });
    for (const key of this.drafts.keys()) if (!draftPaths.has(key)) this.drafts.delete(key);
    this.draftDiagnostics = [...drafts.diagnostics];
    const records: Contribution[] = drafts.items.filter(draft => draft.lifecycle_status === 'active').map(draft => ({ path: draft.path, revision: draft.revision, kind: 'draft', title: draft.title, sources: [...new Set(draft.sources.map(value => value.toLowerCase()))] }));
    // Provenance safety covers all formal files, including unregistered local edits and Projects.
    // This metadata-only enumeration does not expand Registry or semantic indexing scope.
    const registered = draftsOnly ? [] : this.db.prepare("SELECT path FROM documents WHERE kind IN ('knowledge','idea','research') AND state='ready'").all() as { path: string }[];
    const discovered = draftsOnly ? [] : (await enumerateMarkdown(this.vault, [], undefined, undefined, undefined, formalRoots)).paths;
    // A registered file disappearing before reconciliation is uncertainty, not proof of no references.
    const rows = [...new Set([...discovered, ...registered.map(row => row.path)])].map(path => ({ path }));
    const knowledgePaths = new Set<string>();
    for (const row of rows) {
      const key = row.path.toLowerCase(); knowledgePaths.add(key);
      try {
        const project = row.path.startsWith('60_Projects/');
        const filename = project ? await resolveVaultFile(this.vault, row.path) : await resolveMarkdown(this.vault, row.path);
        const observation = stamp(await lstat(filename));
        let cached = this.knowledge.get(key);
        if (!cached || cached.stamp !== observation || freshReferences) {
          const current = project ? await readVaultFile(this.vault, row.path) : await readMarkdown(this.vault, row.path);
          const parsed = parseMarkdownContent(row.path, current.bytes);
          // Backlinks need metadata only; do not retain a second copy of all formal bodies.
          parsed.body_markdown = ''; parsed.annotation = '';
          cached = { stamp: observation, revision: current.revision, parsed }; this.knowledge.set(key, cached);
        }
        if (cached.parsed.state !== 'ready') { drafts.diagnostics.push({ code: 'REFERENCE_UNREADABLE', message: 'Formal reference Properties are invalid', path: row.path }); continue; }
        if (cached.parsed.lifecycle_status !== 'active') continue;
        // Re-resolve against current destinations even when metadata parsing is reused.
        const references = await resolveDocumentReferences(this.vault, row.path, cached.parsed);
        records.push({ path: row.path, revision: cached.revision, kind: 'knowledge', title: cached.parsed.title, sources: [...new Set(references.flatMap(reference => reference.target_path ? [reference.target_path.toLowerCase()] : []))] });
      } catch { drafts.diagnostics.push({ code: 'REFERENCE_UNREADABLE', message: 'A formal reference could not be checked safely', path: row.path }); }
    }
    if (draftsOnly) {
      // Draft browsing does not need to inspect the whole formal library. Destructive previews still refresh it.
      for (const value of this.contributions.values()) { const record: Contribution = JSON.parse(value); if (record.kind === 'knowledge') records.push(record); }
    } else {
      for (const key of this.knowledge.keys()) if (!knowledgePaths.has(key)) this.knowledge.delete(key);
      this.referenceDiagnostics = drafts.diagnostics.slice(this.draftDiagnostics.length);
    }
    const next = new Map(records.map(record => [record.path.toLowerCase(), JSON.stringify(record)]));
    this.db.transaction(() => {
      const removeEdges = this.db.prepare('DELETE FROM temp.source_relations WHERE path_key=?');
      const removeFile = this.db.prepare('DELETE FROM temp.relation_files WHERE path_key=?');
      for (const key of this.contributions.keys()) if (!next.has(key)) { removeEdges.run(key); removeFile.run(key); }
      const put = this.db.prepare('INSERT INTO temp.relation_files VALUES (?,?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,revision=excluded.revision,kind=excluded.kind,title=excluded.title');
      const link = this.db.prepare('INSERT INTO temp.source_relations VALUES (?,?)');
      for (const record of records) {
        const key = record.path.toLowerCase();
        if (this.contributions.get(key) === next.get(key)) continue;
        removeEdges.run(key); put.run(key, record.path, record.revision, record.kind, record.title);
        for (const source of record.sources) link.run(source, key);
      }
    })();
    this.contributions = next; this.diagnostics = [...this.draftDiagnostics, ...this.referenceDiagnostics];
    if (!draftsOnly) { this.generation = generation; this.expires = Date.now() + 10_000; }
  }
  targets(source: string, draftsOnly = false) {
    const rows = this.db.prepare(`SELECT f.path,f.revision,f.kind,f.title FROM temp.source_relations r
      JOIN temp.relation_files f ON f.path_key=r.path_key WHERE r.source_key=? ORDER BY f.path`).all(source.toLowerCase()) as Target[];
    return { drafts: rows.filter(row => row.kind === 'draft').map(({ path, revision, title }) => ({ path, revision, title })), references: rows.filter(row => row.kind === 'knowledge').map(({ path, revision }) => ({ path, revision })), diagnostics: draftsOnly ? this.draftDiagnostics : this.diagnostics };
  }
  related(source: string, draftsOnly = false) {
    const targets = this.targets(source, draftsOnly);
    return { ...targets, drafts: targets.drafts.map(target => this.drafts.get(target.path.toLowerCase())!.draft) };
  }
  removed(relative: string) {
    const key = relative.toLowerCase();
    this.db.prepare('DELETE FROM temp.source_relations WHERE path_key=?').run(key);
    this.db.prepare('DELETE FROM temp.relation_files WHERE path_key=?').run(key);
    this.contributions.delete(key);
  }
  invalidate() { this.expires = 0; }
}
export function sourceRelations(db: Database.Database, vault: string) {
  let index = indexes.get(db);
  if (!index) { index = new SourceRelations(db, vault); indexes.set(db, index); }
  return index;
}
