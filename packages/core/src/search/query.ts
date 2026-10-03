import type Database from 'better-sqlite3';
import { LIMITS, type SearchQuery, type SearchResult } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { normalizeText, stringList } from '../source/parse.js';
import { type DocumentRow } from '../storage/registry.js';
import { indexMeta } from '../storage/database.js';
import { inPathPrefix, pagination } from '../http/registry.js';

const columns = { title: 'title_norm', body: 'body_norm', annotation: 'annotation_norm', metadata: 'metadata_norm' } as const;
type Field = keyof typeof columns;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const context = (row: DocumentRow, field: Field): SearchResult['snippet_context'] => {
  if (field === 'annotation') return 'user_context';
  if (field === 'metadata' || field === 'title') return field;
  if (row.kind === 'knowledge') return 'knowledge';
  const asset = row.asset_json ? JSON.parse(row.asset_json) as { kind: string } : null;
  return asset?.kind === 'inline_markdown' ? 'source_content' : 'record_body';
};
function snippet(text: string, terms: string[]) {
  const normalized = normalizeText(text);
  const position = Math.max(0, ...terms.map(term => normalized.indexOf(term)).filter(index => index >= 0).slice(0, 1));
  const start = Math.max(0, position - 80);
  return Array.from(text.slice(start)).slice(0, LIMITS.snippet_characters).join('');
}

export function searchDocuments(db: Database.Database, query: SearchQuery) {
  const { limit, offset } = pagination(query);
  const normalizedQuery = normalizeText((query.q ?? '').trim());
  const terms = normalizedQuery ? normalizedQuery.split(/\s+/u) : [];
  if (terms.length > LIMITS.query_terms) throw new CoreError('VALIDATION_ERROR', 'Query exceeds the term limit', 400);
  if (terms.length === 0 && !query.source_type && !query.tag && !query.path_prefix) throw new CoreError('EMPTY_QUERY', 'An empty query requires a metadata or path filter', 400);
  const fields = query.fields === undefined ? ['title', 'body', 'annotation', 'metadata'] as Field[] : [...new Set(query.fields.split(','))] as Field[];
  if (fields.some(field => !(field in columns))) throw new CoreError('VALIDATION_ERROR', 'Unsupported search field', 400);
  const conditions = ["state='ready'"];
  const parameters: string[] = [];
  const scope = query.scope ?? 'knowledge';
  if (scope !== 'all') { conditions.push('kind=?'); parameters.push(scope === 'knowledge' ? 'knowledge' : 'source'); }
  if (query.source_type !== undefined) { conditions.push('source_type=?'); parameters.push(query.source_type); }
  for (const term of terms) {
    conditions.push(`(${fields.map(field => `instr(${columns[field]},?)>0`).join(' OR ')})`);
    for (const _field of fields) parameters.push(term);
  }
  let rows = db.prepare(`SELECT * FROM documents WHERE ${conditions.join(' AND ')}`).all(...parameters) as DocumentRow[];
  if (query.path_prefix !== undefined) rows = rows.filter(row => inPathPrefix(row.path, query.path_prefix!));
  if (query.tag !== undefined) rows = rows.filter(row => stringList((JSON.parse(row.metadata_json) as Record<string, unknown>).tags).some(tag => normalizeText(tag) === normalizeText(query.tag!)));
  const titleRank = (row: DocumentRow) => normalizedQuery && row.title_norm === normalizedQuery ? 0 : normalizedQuery && row.title_norm.includes(normalizedQuery) ? 1 : 2;
  const kindRank = (row: DocumentRow) => row.kind === 'knowledge' ? 0 : row.source_type === 'paper' ? 1 : 2;
  rows.sort((a, b) => kindRank(a) - kindRank(b) || titleRank(a) - titleRank(b) || compare(a.path_key, b.path_key));
  const items = rows.slice(offset, offset + limit).map(row => {
    const matched = fields.filter(field => terms.some(term => row[columns[field]].includes(term)));
    // Filter-only results still have a truthful metadata field label.
    const matchedFields: Field[] = matched.length ? matched : ['metadata'];
    const field = matchedFields[0]!;
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const values = [row.original_locator ?? '', row.source_type ?? '', ...stringList(metadata.tags)];
    const value = field === 'title' ? row.title : field === 'body' ? row.body_markdown : field === 'annotation' ? row.annotation
      : values.find(value => terms.some(term => normalizeText(value).includes(term))) ?? (query.tag ? stringList(metadata.tags).find(tag => normalizeText(tag) === normalizeText(query.tag!)) : query.path_prefix && !query.source_type ? row.path : row.source_type) ?? row.path;
    const result: SearchResult = { id: row.id, path: row.path, kind: row.kind, title: row.title, source_type: row.source_type,
      revision: row.revision!, matched_fields: matchedFields, snippet: snippet(value, terms), snippet_field: field, snippet_context: context(row, field) };
    return result;
  });
  const meta = indexMeta(db);
  return { items, total: rows.length, limit, offset, index_generation: meta.index_generation, indexed_at: meta.last_scan_at };
}
