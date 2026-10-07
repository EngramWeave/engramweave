import { isDeepStrictEqual } from 'node:util';
import { FileProblem } from '../files/read.js';
import { parseMarkdown } from './parse.js';
import { editScalarProperty } from '../files/property-scalars.js';

/** Deterministic byte edit shared by registration and Capture replay matching. */
export function pendingSourceBytes(relative: string, bytes: Buffer): Buffer {
  return sourcePropertyBytes(relative, bytes, 'processing_status', 'pending');
}
export function registeredSourceBytes(relative: string, bytes: Buffer): Buffer {
  const pending = pendingSourceBytes(relative, bytes);
  const parsed = parseMarkdown(relative, pending);
  return parsed.state === 'ready' && parsed.kind === 'source' && (parsed.metadata.lifecycle_status == null || parsed.metadata.lifecycle_status === '')
    ? sourcePropertyBytes(relative, pending, 'lifecycle_status', 'active') : pending;
}
export function compiledSourceBytes(relative: string, bytes: Buffer): Buffer {
  return sourcePropertyBytes(relative, bytes, 'processing_status', 'compiled');
}
export function sourcePropertyBytes(relative: string, bytes: Buffer, key: 'processing_status' | 'lifecycle_status', target: 'pending' | 'compiled' | 'active' | 'discarded'): Buffer {
  const before = parseMarkdown(relative, bytes);
  if (before.state !== 'ready' || before.kind !== 'source' || (key === 'processing_status' && (target === 'pending' ? before.processing_status !== null : !['pending', 'compiled'].includes(before.processing_status ?? '')))) return bytes;
  if (before[key] === target && before.metadata[key] === target) return bytes;
  const edited = editScalarProperty(bytes, key, target);
  const after = parseMarkdown(relative, edited);
  const { [key]: _old, ...oldMetadata } = before.metadata;
  const { [key]: _new, ...newMetadata } = after.metadata;
  if (after.state !== 'ready' || after[key] !== target || !isDeepStrictEqual(oldMetadata, newMetadata)
    || before.annotation !== after.annotation || before.body_markdown !== after.body_markdown) {
    throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Stage edit would change other Source content or properties');
  }
  return edited;
}
