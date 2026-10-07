import { SOURCE_VIEWS, PROCESSING_STATUSES, type SourcesQuery } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { normalizeText, stringList } from '../source/parse.js';
import { sourceItem, type DocumentRow } from './registry.js';

export function sourceViews(rows: DocumentRow[]) {
  return Object.fromEntries(SOURCE_VIEWS.map(view => [view, rows.filter(row => inSourceView(row, view)).length]));
}
export function inSourceView(row: DocumentRow, view: typeof SOURCE_VIEWS[number]) {
  const item = sourceItem(row);
  return view === 'all' || view === 'pending' && item.processing_status === 'pending'
    || view === 'processing' && ['compiled', 'reviewed', 'planned'].includes(item.processing_status ?? '')
    || view === 'archived' && item.processing_status === 'archived'
    || view === 'discarded' && item.lifecycle_status === 'discarded'
    || view === 'issues' && row.state !== 'ready';
}
function choices(encoded?: string) {
  if (encoded === undefined) return [] as string[];
  try {
    const values: unknown = JSON.parse(encoded);
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) throw new Error('choices');
    return values as string[];
  } catch { throw new CoreError('VALIDATION_ERROR', 'Filter categories must be a bounded JSON string array', 400); }
}
export function querySources(rows: DocumentRow[], query: SourcesQuery) {
  const types = choices(query.types), tags = choices(query.tags), stages = choices(query.stages), issues = choices(query.issues);
  if (stages.some(stage => !PROCESSING_STATUSES.includes(stage as typeof PROCESSING_STATUSES[number])) || issues.some(issue => !['missing', 'invalid', 'unsupported'].includes(issue))) throw new CoreError('VALIDATION_ERROR', 'Unknown filter category', 400);
  const from = query.captured_from ? Date.parse(query.captured_from) : null;
  const to = query.captured_to ? Date.parse(query.captured_to) : null;
  if (from !== null && !Number.isFinite(from) || to !== null && !Number.isFinite(to) || from !== null && to !== null && from > to) throw new CoreError('VALIDATION_ERROR', 'Invalid captured time range', 400);
  const terms = normalizeText(query.q ?? '').trim().split(/\s+/).filter(Boolean);
  let ranges: { from: string; to: string }[] = [];
  if (query.time_ranges) {
    try {
      const value = JSON.parse(query.time_ranges);
      if (!Array.isArray(value) || value.length > 20 || value.some(range => typeof range?.from !== 'string' || typeof range?.to !== 'string' || !Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to)) || Date.parse(range.from) > Date.parse(range.to))) throw new Error('range');
      ranges = value;
    } catch { throw new CoreError('VALIDATION_ERROR', 'Invalid captured time categories', 400); }
  }
  const filtered = rows.filter(row => {
    const item = sourceItem(row), metadata = JSON.parse(row.metadata_json);
    const captured = row.captured_at ? Date.parse(row.captured_at) : NaN;
    return (query.view ? inSourceView(row, query.view) : row.state === (query.state ?? 'ready'))
      && (!query.state || row.state === query.state)
      && (!query.source_type || row.source_type === query.source_type)
      && (!types.length || types.includes(row.source_type ?? ''))
      && (!tags.length || stringList(metadata.tags).some(tag => tags.includes(tag)))
      && (!stages.length || stages.includes(item.processing_status ?? ''))
      && (!issues.length || issues.includes(row.state))
      && (from === null || Number.isFinite(captured) && captured >= from)
      && (to === null || Number.isFinite(captured) && captured <= to)
      && (!ranges.length || Number.isFinite(captured) && ranges.some(range => captured >= Date.parse(range.from) && captured <= Date.parse(range.to)))
      && terms.every(term => normalizeText([row.title, row.path, row.original_locator, row.body_markdown, row.annotation, row.metadata_norm].join('\n')).includes(term));
  });
  const sort = query.sort ?? 'title_asc';
  if (query.sort) filtered.sort((a, b) => {
    if (sort.startsWith('captured')) {
      const first = a.captured_at ? Date.parse(a.captured_at) : NaN, second = b.captured_at ? Date.parse(b.captured_at) : NaN;
      if (!Number.isFinite(first) || !Number.isFinite(second)) return Number.isFinite(first) ? -1 : Number.isFinite(second) ? 1 : a.path_key.localeCompare(b.path_key);
      return (first - second) * (sort.endsWith('desc') ? -1 : 1) || a.path_key.localeCompare(b.path_key);
    }
    return a.title.localeCompare(b.title) * (sort.endsWith('desc') ? -1 : 1) || a.path_key.localeCompare(b.path_key);
  });
  return filtered;
}
