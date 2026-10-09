import { Value } from '@sinclair/typebox/value';
import { AnalysisProfileIdSchema } from '@engramweave/contracts';
import { editScalarProperty } from '../files/property-scalars.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown } from '../source/parse.js';
import { writeSourceProperties } from '../files/properties.js';
import { PropertyNative } from '../files/property-native.js';
import { CoreError } from '../errors.js';

export function sourceProfileBytes(bytes: Buffer, id: string) {
  if (!Value.Check(AnalysisProfileIdSchema, id)) throw new CoreError('VALIDATION_ERROR', 'Invalid Analysis Profile reference', 400);
  return editScalarProperty(bytes, 'analysis_profile', id, true);
}
export async function writeAnalysisSelection(vault: string, input: { path: string; revision: string; profile_id: string }) {
  const file = await readMarkdown(vault, input.path);
  if (file.revision !== input.revision) throw new CoreError('SOURCE_CHANGED', 'Source changed; reload before changing its selection', 409);
  const parsed = parseMarkdown(input.path, file.bytes);
  if (parsed.kind !== 'source' || parsed.state !== 'ready' || parsed.processing_status !== 'pending' || parsed.lifecycle_status !== 'active') throw new CoreError('INVALID_SOURCE', 'Only an active pending Source can change its preset selection', 422);
  const native = new PropertyNative();
  try { const next = await writeSourceProperties(vault, input.path, file, sourceProfileBytes(file.bytes, input.profile_id), native); return { path: input.path, revision: next.revision }; }
  finally { await native.close(); }
}
