import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Job, Source } from '@engramweave/contracts';
import { documentPathKey } from '../files/paths.js';
import { normalizeText, processingStatus, stringList, type ParsedDocument } from '../source/parse.js';
import { indexMeta } from './database.js';

export interface DocumentRow {
  id: string; path_key: string; path: string; kind: 'source' | 'knowledge'; state: Source['state'];
  revision: string | null; size: number | null; mtime: number | null; title: string; source_type: string | null;
  captured_at: string | null; original_locator: string | null; metadata_json: string; asset_json: string | null;
  diagnostics_json: string; annotation: string; body_markdown: string; title_norm: string; body_norm: string;
  annotation_norm: string; metadata_norm: string; indexed_at: string | null;
}
export interface Projection { path: string; parsed: ParsedDocument; revision: string | null; size: number | null; mtime: number | null }
export const getDocument = (db: Database.Database, relative: string) => db.prepare('SELECT * FROM documents WHERE path_key=?').get(documentPathKey(relative)) as DocumentRow | undefined;
export const allDocuments = (db: Database.Database) => db.prepare('SELECT * FROM documents ORDER BY path_key').all() as DocumentRow[];
export function sourceItem(row: DocumentRow): Source {
  return { id: row.id, path: row.path, title: row.title, source_type: row.source_type, state: row.state, revision: row.revision,
    original_locator: row.original_locator, captured_at: row.captured_at,
    processing_status: processingStatus((JSON.parse(row.metadata_json) as Record<string, unknown>).processing_status),
    asset: row.asset_json === null ? null : JSON.parse(row.asset_json), diagnostics: JSON.parse(row.diagnostics_json) };
}
export function parsedRow(row: DocumentRow): ParsedDocument {
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  return { kind: row.kind, state: row.state === 'missing' ? 'invalid' : row.state, title: row.title, source_type: row.source_type,
    captured_at: row.captured_at, original_locator: row.original_locator, metadata,
    processing_status: processingStatus(metadata.processing_status),
    annotation: row.annotation, body_markdown: row.body_markdown, asset: row.asset_json ? JSON.parse(row.asset_json) : null,
    diagnostics: JSON.parse(row.diagnostics_json) };
}

export function publishScan(db: Database.Database, jobId: string, projections: Projection[], knownRoots: string[], warnings: Source['diagnostics']): NonNullable<Job['summary']> {
  return db.transaction(() => {
    const generation = indexMeta(db).index_generation + 1;
    const indexedAt = new Date().toISOString();
    const summary: NonNullable<Job['summary']> = { added: 0, updated: 0, unchanged: 0, missing: 0, invalid: 0, unsupported: 0,
      source_count: 0, knowledge_count: 0, index_generation: generation, warnings, finished_at: indexedAt };
    const columns = 'id path_key path kind state revision size mtime title source_type captured_at original_locator metadata_json asset_json diagnostics_json annotation body_markdown title_norm body_norm annotation_norm metadata_norm indexed_at'.split(' ');
    const insert = db.prepare(`INSERT INTO documents (${columns.join(',')}) VALUES (${columns.map(column => `@${column}`).join(',')}) ON CONFLICT(path_key) DO UPDATE SET ${columns.filter(column => !['id', 'path_key'].includes(column)).map(column => `${column}=excluded.${column}`).join(',')}`);
    const seen = new Set<string>();
    for (const projection of projections) {
      const { parsed } = projection;
      const old = getDocument(db, projection.path);
      const key = documentPathKey(projection.path);
      if (seen.has(key)) throw new Error('Conflicting projection path');
      seen.add(key);
      if (parsed.state !== 'ready') summary[parsed.state]++;
      else {
        if (!old) summary.added++;
        else if (old.state === 'ready' && old.revision === projection.revision) summary.unchanged++;
        else summary.updated++;
        if (parsed.kind === 'source') summary.source_count++; else summary.knowledge_count++;
      }
      const searchable = parsed.state === 'ready';
      const metadata = searchable ? parsed.metadata : {};
      const body = searchable ? parsed.body_markdown : '';
      const annotation = searchable ? parsed.annotation : '';
      const row: DocumentRow = { id: old?.id ?? randomUUID(), path_key: key, path: projection.path, kind: parsed.kind, state: parsed.state,
        revision: projection.revision, size: projection.size, mtime: projection.mtime, title: parsed.title,
        source_type: parsed.source_type, captured_at: parsed.captured_at, original_locator: parsed.original_locator,
        metadata_json: JSON.stringify(metadata), asset_json: searchable && parsed.asset ? JSON.stringify(parsed.asset) : null,
        diagnostics_json: JSON.stringify(parsed.diagnostics), annotation, body_markdown: body,
        title_norm: searchable ? normalizeText(parsed.title) : '', body_norm: normalizeText(body), annotation_norm: normalizeText(annotation),
        metadata_norm: normalizeText([parsed.original_locator ?? '', parsed.source_type ?? '', ...stringList(metadata.tags)].join('\n')),
        // Publication alone is not a successful content read or hash validation.
        indexed_at: projection.revision !== null ? indexedAt : old?.indexed_at ?? null };
      if (!searchable) row.metadata_norm = '';
      insert.run(row);
    }
    for (const old of allDocuments(db)) {
      if (seen.has(old.path_key) || old.state === 'missing') continue;
      db.prepare("UPDATE documents SET state='missing', metadata_json='{}',asset_json=NULL,annotation='',body_markdown='',title_norm='',body_norm='',annotation_norm='',metadata_norm='',diagnostics_json=? WHERE id=?")
        .run(JSON.stringify([{ code: 'FILE_MISSING', message: 'Document is absent from the completed scan', path: old.path }]), old.id);
      summary.missing++;
    }
    db.prepare('UPDATE meta SET index_generation=?,last_scan_at=?,known_scan_roots=? WHERE id=1').run(generation, indexedAt, JSON.stringify(knownRoots));
    const changed = db.prepare("UPDATE jobs SET status='succeeded',finished_at=?,summary_json=?,error_json=NULL WHERE id=? AND status='running'").run(indexedAt, JSON.stringify(summary), jobId);
    if (changed.changes !== 1) throw new Error('Publishing scan has no running Job');
    return summary;
  })();
}
