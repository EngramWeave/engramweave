import type { RecallHit } from '@engramweave/contracts';
import type { SemanticRecall } from '../recall/index.js';
import { CoreError } from '../errors.js';
import type { AnalysisSnapshot, AnalysisEvidence } from './input.js';

export async function taskContext(snapshot: AnalysisSnapshot, task: 'review' | 'relation', recall: Pick<SemanticRecall, 'recall'>, signal: AbortSignal): Promise<AnalysisEvidence> {
  signal.throwIfAborted();
  const query = `${snapshot.input.source.title}\n${snapshot.input.draft.title}\n${snapshot.input.draft.body}`.slice(0, 1800);
  const context = snapshot.templates[task].context;
  try {
    const value = await recall.recall({ q: query || 'Related material', scope: context.scope, limit: context.limit }, signal);
    signal.throwIfAborted();
    if (context.required && (!value.items.length || value.coverage.stale_documents > 0 || value.diagnostics.length)) throw new CoreError('UNSUPPORTED_CONTENT', 'Required library context is missing or incomplete', 422);
    return { items: value.items, coverage: value.coverage, diagnostics: value.diagnostics };
  } catch (error) {
    if (signal.aborted || context.required) throw error;
    return { items: [], coverage: null, diagnostics: [{ code: 'LIBRARY_CONTEXT_UNAVAILABLE', message: 'Library context is unavailable; only submitted material was examined.' }] };
  }
}
export function mergeEvidence(own: AnalysisEvidence, reused: AnalysisEvidence): AnalysisEvidence {
  const items = new Map<string, RecallHit>();
  for (const item of [...own.items, ...reused.items]) items.set(JSON.stringify([item.path, item.revision, item.chunk_id]), item);
  return { items: [...items.values()], coverage: own.coverage, diagnostics: [...own.diagnostics, ...reused.diagnostics] };
}
