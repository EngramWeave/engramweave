import path from 'node:path';
import type { Config, ReviewFile, ReviewBrowserQuery, AnalyzerJob } from '@engramweave/contracts';
import { REVIEW_VIEWS, LIMITS } from '@engramweave/contracts';
import { listAllDrafts, parseDraft } from './files.js';
import { readMarkdown } from '../files/read.js';
import { readDocument } from '../http/documents.js';
import type { CoreServices } from '../http/context.js';
import { CoreError } from '../errors.js';

type SourceSummary = { revision: string; title: string; stage: ReviewFile['source_stage']; lifecycle: ReviewFile['source_lifecycle'] };
function analysisState(jobs: (AnalyzerJob | null)[], source: SourceSummary | null, draftRevision: string): ReviewFile['analysis'] {
  if (jobs.every(job => !job)) return 'none';
  if (jobs.some(job => job && ['queued', 'running'].includes(job.status))) return 'running';
  if (jobs.some(job => job && (job.draft_revision !== draftRevision || job.source_revision !== source?.revision))) return 'stale';
  const states = jobs.map((job, index) => job ? (index === 0 ? job.review.status : job.relation.status) : 'pending');
  if (states.every(state => state === 'succeeded')) return 'complete';
  if (states.some(state => state === 'succeeded')) return 'partial';
  return 'failed';
}
export async function reviewFiles(config: Config, services: CoreServices, query: ReviewBrowserQuery) {
  const times = new Map<string, string>();
  let fileBytes = 0;
  const drafts = await listAllDrafts(config.vault_path, async (vault, relative, checked) => {
    const file = await readMarkdown(vault, relative, checked);
    fileBytes += file.size;
    if (fileBytes > LIMITS.scan_total_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'Draft browsing exceeds its metadata read budget', 413);
    times.set(relative, new Date(file.mtime).toISOString());
    return parseDraft(relative, file);
  });
  const sources = new Map<string, { document: SourceSummary | null; selected: string | null; diagnostics: ReviewFile['diagnostics'] }>();
  for (const sourcePath of new Set(drafts.items.flatMap(draft => draft.sources))) {
    let document: SourceSummary | null = null;
    const diagnostics: ReviewFile['diagnostics'] = [];
    try { const current = await readDocument(config, services, sourcePath); document = { revision: current.revision, title: current.title, stage: current.kind === 'source' ? current.processing_status ?? null : null, lifecycle: current.lifecycle_status }; }
    catch (error) { diagnostics.push({ code: error instanceof CoreError ? error.code : 'SOURCE_UNREADABLE', message: 'The linked Source is missing or cannot be read safely.' }); }
    sources.set(sourcePath.toLowerCase(), { document, selected: document ? await services.humanReview?.selection(sourcePath) ?? null : null, diagnostics });
  }
  const items: ReviewFile[] = drafts.items.map(draft => {
    const sourcePath = draft.sources.length === 1 ? draft.sources[0]! : null;
    const related = sourcePath ? sources.get(sourcePath.toLowerCase())! : null;
    const source = related?.document ?? null;
    return { path: draft.path, title: draft.title, revision: draft.revision, updated_at: times.get(draft.path) ?? null, lifecycle_status: draft.lifecycle_status,
      source_path: sourcePath, source_title: source?.title ?? null, source_revision: source?.revision ?? null, source_stage: source?.stage ?? null, source_lifecycle: source?.lifecycle ?? null,
      selected: Boolean(related?.selected && related.selected.toLowerCase() === draft.path.toLowerCase()),
      analysis: analysisState([services.analyzer?.latestForDraft(draft.path, 'review') ?? null, services.analyzer?.latestForDraft(draft.path, 'relation') ?? null], source, draft.revision),
      diagnostics: sourcePath ? related!.diagnostics : [{ code: 'MULTIPLE_SOURCES', message: 'Review currently supports one Source per Draft.' }] };
  });
  for (const problem of drafts.diagnostics) items.push({ path: problem.path, title: path.posix.basename(problem.path, '.md'), revision: null, updated_at: times.get(problem.path) ?? null,
    lifecycle_status: null, source_path: null, source_title: null, source_revision: null, source_stage: null, source_lifecycle: null, selected: false, analysis: 'none', diagnostics: [{ code: problem.code, message: problem.message }] });
  const matches = (item: ReviewFile, view: string) => view === 'discarded' ? item.lifecycle_status === 'discarded' : item.lifecycle_status !== 'discarded' && (
    view === 'all' || view === 'issues' && item.diagnostics.length > 0 || view === 'to_review' && item.revision !== null && item.diagnostics.length === 0 && item.source_stage === 'compiled' && item.source_lifecycle === 'active'
    || view === 'reviewed' && item.selected && item.source_stage === 'reviewed' || view === 'planned' && item.selected && item.source_stage === 'planned');
  const views = Object.fromEntries(REVIEW_VIEWS.map(view => [view, items.filter(item => matches(item, view)).length]));
  const q = query.q?.trim().toLowerCase() ?? '';
  const stages = query.stages?.split(',').map(stage => stage.trim()).filter(Boolean) ?? [];
  const filtered = items.filter(item => matches(item, query.view ?? 'all') && (!q || [item.title, item.path, item.source_title, item.source_path].join('\n').toLowerCase().includes(q))
    && (!query.path || item.path.toLowerCase() === query.path.toLowerCase()) && (!stages.length || stages.includes(item.source_stage ?? '')) && (!query.analysis || item.analysis === query.analysis) && (!query.source_path || item.source_path?.toLowerCase() === query.source_path.toLowerCase()));
  filtered.sort((a, b) => (query.sort === 'updated_desc' ? (b.updated_at ?? '').localeCompare(a.updated_at ?? '') : query.sort === 'updated_asc' ? (a.updated_at ?? '').localeCompare(b.updated_at ?? '') : a.title.localeCompare(b.title)) || a.path.localeCompare(b.path));
  const offset = query.offset ?? 0;
  return { items: filtered.slice(offset, offset + (query.limit ?? 20)), total: filtered.length, views };
}
