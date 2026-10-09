import { Value } from '@sinclair/typebox/value';
import { ReviewResultSchema, RelationResultSchema, type ReviewResult, type RelationResult } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import type { AnalysisSnapshot, AnalysisEvidence } from './input.js';

export const analysisSchema = (task: 'review' | 'relation') => task === 'review' ? ReviewResultSchema : RelationResultSchema;
/** Provider strict schemas forbid path allOf. Core still checks the full contract and exact evidence. */
export function analysisModelSchema(task: 'review' | 'relation'): object {
  const schema = JSON.parse(JSON.stringify(analysisSchema(task)));
  schema.properties[task === 'review' ? 'findings' : 'suggestions'].items.properties.evidence.items.properties.path = { type: 'string' };
  return schema;
}
export function analysisOutput(text: string, task: 'review' | 'relation', snapshot: AnalysisSnapshot, evidence: AnalysisEvidence, allowFence = false): ReviewResult | RelationResult {
  if (allowFence) text = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)?.[1] ?? text;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CoreError('INVALID_MODEL_OUTPUT', 'Analyzer returned invalid JSON', 422); }
  if (Buffer.byteLength(text) > 250_000 || !Value.Check(analysisSchema(task), value)) throw new CoreError('INVALID_MODEL_OUTPUT', 'Analyzer returned an invalid or oversized result', 422);
  const result = value as ReviewResult | RelationResult;
  const citations = ('findings' in result ? result.findings : result.suggestions).flatMap(item => item.evidence);
  for (const citation of citations) {
    const input = [snapshot.input.source, snapshot.input.draft].find(item => item.path === citation.path && item.revision === citation.revision);
    const valid = citation.end_line >= citation.start_line && (input ? citation.end_line <= input.available_lines
      : evidence.items.some(item => item.path === citation.path && item.revision === citation.revision && citation.start_line >= item.start_line && citation.end_line <= item.end_line));
    if (!valid) throw new CoreError('INVALID_MODEL_OUTPUT', 'Analyzer cited material or lines outside its actual input', 422);
  }
  return result;
}
