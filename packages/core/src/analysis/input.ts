import { Value } from '@sinclair/typebox/value';
import { AnalyzeRequestSchema, type AnalyzeRequest, type AnalysisProfile, type RecallHit } from '@engramweave/contracts';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown } from '../source/parse.js';
import { readDraft } from '../drafts/files.js';
import { CoreError } from '../errors.js';
import { loadAnalysisTemplate } from './templates.js';
import type { AnalysisSettingsStore } from './settings.js';

export type AnalysisSnapshot = Awaited<ReturnType<typeof freezeAnalysis>>;
export async function freezeAnalysis(vault: string, request: AnalyzeRequest, settings: AnalysisSettingsStore) {
  if (!Value.Check(AnalyzeRequestSchema, request)) throw new CoreError('VALIDATION_ERROR', 'Invalid explicit Draft analysis request', 400);
  const [source, draft, draftFile] = await Promise.all([readMarkdown(vault, request.source_path), readDraft(vault, request.draft_path), readMarkdown(vault, request.draft_path)]);
  const parsed = parseMarkdown(request.source_path, source.bytes);
  if (source.revision !== request.source_revision || draft.revision !== request.draft_revision || draftFile.revision !== draft.revision) throw new CoreError('SOURCE_CHANGED', 'Source or Draft changed; reload before analysis', 409);
  if (parsed.state !== 'ready' || parsed.kind !== 'source' || parsed.lifecycle_status !== 'active' || parsed.processing_status === 'archived'
    || draft.lifecycle_status !== 'active' || !draft.sources.includes(request.source_path)) throw new CoreError('INVALID_SOURCE', 'Analysis needs an active readable Draft and its unarchived Source', 422);
  if (parsed.asset?.kind !== 'inline_markdown') throw new CoreError('UNSUPPORTED_CONTENT', 'Referenced assets are not extracted; analysis requires submitted text', 422);
  if (!request.profile_id && parsed.metadata.analysis_profile != null && parsed.metadata.analysis_profile !== '' && typeof parsed.metadata.analysis_profile !== 'string') throw new CoreError('CONFIG_ERROR', 'Source Analysis Profile reference must be a string', 400);
  const selected = request.profile_id ?? (typeof parsed.metadata.analysis_profile === 'string' && parsed.metadata.analysis_profile ? parsed.metadata.analysis_profile : undefined);
  const profile: AnalysisProfile = await settings.select(selected);
  const [review, relation] = await Promise.all([loadAnalysisTemplate(vault, profile.review.template_path), loadAnalysisTemplate(vault, profile.relation.template_path)]);
  const input = { source: { path: request.source_path, revision: source.revision, title: parsed.title, submitted_content: parsed.body_markdown, annotation: parsed.annotation,
    original_locator: parsed.original_locator, available_lines: source.bytes.toString('utf8').split(/\r?\n/).length,
    numbered_lines: source.bytes.toString('utf8').split(/\r?\n/).map((text, i) => `${i + 1}: ${text}`) },
    draft: { path: draft.path, revision: draft.revision, title: draft.title, body: draft.body, metadata: draft.metadata, available_lines: draftFile.bytes.toString('utf8').split(/\r?\n/).length,
      numbered_lines: draftFile.bytes.toString('utf8').split(/\r?\n/).map((text, i) => `${i + 1}: ${text}`) } };
  if (Buffer.byteLength(JSON.stringify(input)) > 1_000_000) throw new CoreError('PAYLOAD_TOO_LARGE', 'Analyzer submitted input exceeds its budget; no text was truncated', 413);
  return { input, profile, templates: { review, relation } };
}
export async function verifyAnalysisInput(vault: string, snapshot: AnalysisSnapshot) {
  try { for (const item of [snapshot.input.source, snapshot.input.draft]) if ((await readMarkdown(vault, item.path)).revision !== item.revision) throw new Error('changed'); }
  catch { throw new CoreError('SOURCE_CHANGED', 'Common Source or Draft input changed or is unavailable during analysis', 409); }
}
export type AnalysisEvidence = { items: RecallHit[]; coverage: unknown; diagnostics: unknown[] };
