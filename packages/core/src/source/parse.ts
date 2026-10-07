import path from 'node:path';
import { parseDocument, visit } from 'yaml';
import { LIMITS, PROCESSING_STATUSES, type Asset, type Source } from '@engramweave/contracts';
import { FileProblem } from '../files/read.js';
import { markdownPath } from '../files/paths.js';

export type Diagnostic = Source['diagnostics'][number];
export interface ParsedDocument {
  kind: 'source' | 'knowledge'; state: 'ready' | 'invalid' | 'unsupported';
  title: string; source_type: string | null; captured_at: string | null; original_locator: string | null;
  processing_status: Source['processing_status']; lifecycle_status: Source['lifecycle_status'];
  metadata: Record<string, unknown>; annotation: string; body_markdown: string;
  asset: Asset | null; diagnostics: Diagnostic[];
}
export const normalizeText = (text: string) => text.normalize('NFC').toLowerCase();
export const processingStatus = (value: unknown): Source['processing_status'] =>
  typeof value === 'string' && PROCESSING_STATUSES.includes(value as typeof PROCESSING_STATUSES[number]) ? value as NonNullable<Source['processing_status']> : null;
export const lifecycleStatus = (value: unknown): Source['lifecycle_status'] =>
  value == null || value === '' || value === 'active' ? 'active' : value === 'discarded' ? 'discarded' : null;
export const stringList = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
const validList = (value: unknown) => value == null || typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
const datePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const externalLocator = (value: string) => /^(?:https?|zotero):/i.test(value);
function firstHeading(body: string): string | undefined {
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}#(?:[ \t]+|$)(.*)$/.exec(line)?.[1];
    if (heading !== undefined) return heading.replace(/[ \t]+#+[ \t]*$/, '').trim();
  }
  return undefined;
}

function jsonCompatible(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const good = (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) && Object.values(value).every(item => jsonCompatible(item, seen, depth + 1));
  seen.delete(value);
  return good;
}

export function parseMarkdown(relative: string, bytes: Buffer): ParsedDocument {
  markdownPath(relative);
  const kind = relative.split('/')[0] === '20_Sources' ? 'source' : 'knowledge';
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string) => diagnostics.push({ code, message, path: relative });
  const result: ParsedDocument = { kind, state: 'ready', title: path.posix.basename(relative, path.posix.extname(relative)), source_type: null,
    captured_at: null, original_locator: null, processing_status: null, lifecycle_status: null, metadata: {}, annotation: '', body_markdown: '', asset: null, diagnostics };
  const fail = (code: string, message: string, state: 'invalid' | 'unsupported' = 'invalid') => {
    result.state = state; result.processing_status = null; result.lifecycle_status = null; result.metadata = {}; result.annotation = ''; result.body_markdown = ''; result.asset = null;
    report(code, message); return result;
  };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('INVALID_UTF8', 'Document is not valid UTF-8'); }
  let body = text;
  let metadata: Record<string, unknown> = {};
  if (/^---(?:\r?\n|$)/.test(text)) {
    const opening = /^---\r?\n/.exec(text);
    const closing = opening && /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text.slice(opening[0].length));
    if (!opening || !closing) return fail('FRONTMATTER_UNCLOSED', 'Frontmatter has no closing delimiter');
    try {
      const yaml = parseDocument(text.slice(opening[0].length, opening[0].length + closing.index), { version: '1.2', schema: 'core', uniqueKeys: true, stringKeys: true });
      if (yaml.errors.length || yaml.warnings.length) return fail('INVALID_YAML', 'Frontmatter contains invalid or unsupported YAML');
      let aliases = 0;
      visit(yaml, { Alias() { aliases++; } });
      if (aliases > LIMITS.yaml_aliases) return fail('INVALID_YAML', 'Frontmatter exceeds the alias limit');
      const value: unknown = yaml.toJS({ maxAliasCount: LIMITS.yaml_aliases });
      if (!value || typeof value !== 'object' || Array.isArray(value) || !jsonCompatible(value)) return fail('INVALID_METADATA', 'Frontmatter must be a JSON-compatible mapping');
      metadata = value as Record<string, unknown>;
      body = text.slice(opening[0].length + closing.index + closing[0].length);
    } catch { return fail('INVALID_YAML', 'Frontmatter contains invalid or excessive aliases'); }
  }
  if (kind === 'source' && metadata.type !== 'raw_source') return fail('UNSUPPORTED_TYPE', 'Source requires type raw_source', 'unsupported');
  if (kind === 'knowledge' && metadata.type === 'raw_source') return fail('DIRECTORY_TYPE_CONFLICT', 'Raw Source cannot be read as Knowledge');
  if (metadata.annotation != null && typeof metadata.annotation !== 'string') return fail('INVALID_ANNOTATION', 'Annotation must be a string or null');
  if (metadata.title != null && typeof metadata.title !== 'string') return fail('INVALID_TITLE', 'Title must be a string');
  if (!validList(metadata.author) || !validList(metadata.tags)) return fail('INVALID_LIST', 'Author and tags must be strings or string lists');
  result.lifecycle_status = lifecycleStatus(metadata.lifecycle_status);
  if (result.lifecycle_status === null) return fail('INVALID_LIFECYCLE_STATUS', 'Lifecycle status must be active, discarded, empty or null');
  if (kind === 'source') {
    if (metadata.processing_status != null && metadata.processing_status !== '' && processingStatus(metadata.processing_status) === null) {
      return fail('INVALID_PROCESSING_STATUS', 'Processing status must be pending, compiled, reviewed, planned, archived, empty or null');
    }
    result.processing_status = processingStatus(metadata.processing_status);
    if (typeof metadata.source_type !== 'string' || !metadata.source_type.trim()) return fail('INVALID_SOURCE_TYPE', 'Source type must be a nonempty string');
    result.source_type = metadata.source_type;
    if (metadata.source != null && typeof metadata.source !== 'string') return fail('INVALID_LOCATOR', 'Source locator must be a string');
    result.original_locator = typeof metadata.source === 'string' ? metadata.source : null;
    if (result.source_type === 'web') {
      try { if (!result.original_locator || !['http:', 'https:'].includes(new URL(result.original_locator).protocol)) throw new Error('invalid'); }
      catch { return fail('INVALID_LOCATOR', 'Web Source requires an HTTP or HTTPS locator'); }
    }
    if (metadata.captured_at != null && typeof metadata.captured_at !== 'string') return fail('INVALID_CAPTURED_AT', 'Captured date must be a string or null');
    result.captured_at = typeof metadata.captured_at === 'string' ? metadata.captured_at : null;
    if (result.captured_at === null) report('CAPTURED_AT_UNKNOWN', 'Captured date is unknown');
    else if (!datePattern.test(result.captured_at) || Number.isNaN(Date.parse(result.captured_at))) report('CAPTURED_AT_FORMAT', 'Captured date has an unrecognized format');
    if (metadata.asset != null && (typeof metadata.asset !== 'string' || !metadata.asset.trim())) return fail('INVALID_ASSET', 'Asset must be a nonempty reference string');
    if (typeof metadata.asset === 'string' && !externalLocator(metadata.asset) && !/^\[\[.+\]\]$/.test(metadata.asset)) return fail('INVALID_ASSET', 'Asset must be a Wiki Link or an allowed external URI');
    const locator = typeof metadata.asset === 'string' ? metadata.asset : /\.source\.md$/i.test(relative) && result.original_locator && externalLocator(result.original_locator) ? result.original_locator : null;
    if (/\.source\.md$/i.test(relative) && (!locator || !externalLocator(locator) && !/^\[\[.+\]\]$/.test(locator))) return fail('ASSET_REQUIRED', 'Source Record requires an asset reference');
    result.asset = locator ? { kind: externalLocator(locator) ? 'external_ref' : 'vault_file', locator, availability: externalLocator(locator) ? 'unverified' : 'unsupported' }
      : { kind: 'inline_markdown', locator: relative, availability: 'available' };
  } else if (!validList(metadata.sources)) report('UNSUPPORTED_PROVENANCE', 'Complex provenance is preserved but not resolved');
  const heading = firstHeading(body);
  result.title = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : heading || result.title;
  result.annotation = typeof metadata.annotation === 'string' ? metadata.annotation : '';
  const { annotation: _annotation, ...rest } = metadata;
  result.metadata = rest;
  result.body_markdown = body;
  return result;
}

export function problemDocument(relative: string, error: unknown): ParsedDocument {
  const problem = error instanceof FileProblem ? error : new FileProblem('FILE_READ_ERROR', 'invalid', 'Document could not be read safely');
  return { kind: relative.startsWith('20_Sources/') ? 'source' : 'knowledge', state: problem.state,
    title: path.posix.basename(relative), source_type: null, captured_at: null, original_locator: null, processing_status: null, lifecycle_status: null,
    metadata: {}, annotation: '', body_markdown: '', asset: null,
    diagnostics: [{ code: problem.code, message: problem.message, path: relative }] };
}
