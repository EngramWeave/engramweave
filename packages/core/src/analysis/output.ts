import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { ReviewResultSchema, RelationResultSchema, type ReviewResult, type RelationResult } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import type { AnalysisSnapshot, AnalysisEvidence } from './input.js';
import { AnalysisMaterials } from './materials.js';

export const analysisSchema = (task: 'review' | 'relation') => task === 'review' ? ReviewResultSchema : RelationResultSchema;
export function analysisModelSchema(task: 'review' | 'relation') {
  return Type.Object({ summary: Type.String({ maxLength: 12000 }),
    [task === 'review' ? 'findings' : 'suggestions']: Type.Array(Type.Object({ message: Type.String({ minLength: 1, maxLength: 4000 }),
      evidence: Type.Array(Type.String({ pattern: '^[SDK][1-9][0-9]*$' }), { minItems: 1, maxItems: 10 }) }, { additionalProperties: false }), { maxItems: 30 }) }, { additionalProperties: false });
}
export function analysisModelOutput(text: string, task: 'review' | 'relation', snapshot: AnalysisSnapshot, evidence: AnalysisEvidence, materials: AnalysisMaterials, allowFence = false): ReviewResult | RelationResult {
  if (allowFence) text = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)?.[1] ?? text;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CoreError('INVALID_MODEL_OUTPUT', 'Analyzer returned invalid JSON', 422); }
  if (Buffer.byteLength(text) > 250_000 || !Value.Check(analysisModelSchema(task), value)) throw new CoreError('INVALID_MODEL_OUTPUT', 'Analyzer must return summary and brief suggestions with evidence IDs', 422);
  const result = value as Record<string, unknown>;
  const field = task === 'review' ? 'findings' : 'suggestions';
  const items = result[field] as { message: string; evidence: string[] }[];
  return analysisOutput(JSON.stringify({ summary: result.summary, [field]: items.map(item => ({ message: item.message, evidence: [...new Set(item.evidence)].map(id => materials.resolve(id)) })), limitations: [] }), task, snapshot, evidence);
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
