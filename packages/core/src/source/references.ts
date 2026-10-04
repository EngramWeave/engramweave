import path from 'node:path';
import type { Document } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { markdownPath, normalizeVaultPath, resolveVaultFile } from '../files/paths.js';
import { stringList, type ParsedDocument } from './parse.js';

type Reference = Document['original_references'][number];
const referenceCodes = new Set(['ASSET_MISSING', 'ASSET_AMBIGUOUS', 'ASSET_OUTSIDE_SCOPE', 'ASSET_UNSUPPORTED']);

export async function resolveReference(vault: string, record: string, raw: string, documentLink: boolean): Promise<Reference> {
  const result: Reference = { raw, target_path: null, anchor: null, alias: null, availability: 'unsupported' };
  if (/^(?:https?|zotero):/i.test(raw)) {
    try {
      const uri = new URL(raw);
      if (uri.protocol === 'zotero:' || (['http:', 'https:'].includes(uri.protocol) && uri.hostname)) result.availability = 'unverified';
    } catch { /* Preserve malformed external locators without opening them. */ }
    return result;
  }
  const match = /^\[\[([^\[\]\r\n]+)\]\]$/.exec(raw);
  if (!match) return result;
  const inner = match[1]!;
  const pipe = inner.indexOf('|');
  if (pipe >= 0) result.alias = inner.slice(pipe + 1);
  const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const hash = target.indexOf('#');
  if (hash >= 0) result.anchor = target.slice(hash + 1);
  const locator = (hash >= 0 ? target.slice(0, hash) : target).trim();
  let relative: string;
  try {
    if (!locator || locator.startsWith('/') || /[\\:\x00-\x1f]/.test(locator)) throw new Error('Invalid locator');
    // Only explicit ./ or ../ denotes a path relative to the Record's directory.
    relative = normalizeVaultPath(locator.startsWith('./') || locator.startsWith('../')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(record), locator)) : locator);
    if (documentLink) markdownPath(/\.md$/i.test(relative) ? relative : `${relative}.md`);
  } catch { result.availability = 'outside_scope'; return result; }
  const candidates = documentLink && !/\.md$/i.test(relative) ? [relative, `${relative}.md`] : [relative];
  const available: string[] = [];
  for (const candidate of candidates) {
    try { await resolveVaultFile(vault, candidate); available.push(candidate); }
    catch (error) {
      if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') continue;
      if (error instanceof CoreError && error.code === 'PATH_OUTSIDE_SCOPE') {
        result.availability = error.details?.reason === 'ambiguous' ? 'ambiguous' : 'outside_scope';
      }
      return result;
    }
  }
  if (available.length > 1) { result.availability = 'ambiguous'; return result; }
  result.target_path = available[0] ?? candidates[candidates.length - 1]!;
  if (documentLink && !/\.md$/i.test(result.target_path)) { result.availability = 'unsupported'; return result; }
  result.availability = available.length ? 'available' : 'missing';
  return result;
}

/** Re-evaluate Asset accessibility even when refresh reuses an unchanged Record parse. */
export async function resolveDocumentReferences(vault: string, record: string, parsed: ParsedDocument): Promise<Reference[]> {
  parsed.diagnostics = parsed.diagnostics.filter(item => !referenceCodes.has(item.code));
  if (parsed.state !== 'ready') return [];
  const raw = parsed.kind === 'knowledge' ? stringList(parsed.metadata.sources)
    : [parsed.original_locator, typeof parsed.metadata.asset === 'string' ? parsed.metadata.asset : null].filter((value): value is string => value !== null);
  const references: Reference[] = [];
  for (const locator of raw) references.push(await resolveReference(vault, record, locator, parsed.kind === 'knowledge'));
  if (parsed.asset && parsed.asset.kind !== 'inline_markdown') {
    // Resolve the raw locator, never a previously cached normalized asset path.
    const locator = typeof parsed.metadata.asset === 'string' ? parsed.metadata.asset : parsed.original_locator!;
    const reference = references.find(item => item.raw === locator) ?? await resolveReference(vault, record, locator, false);
    parsed.asset.locator = reference.target_path ?? locator;
    parsed.asset.availability = ['available', 'missing', 'unverified'].includes(reference.availability)
      ? reference.availability as 'available' | 'missing' | 'unverified' : 'unsupported';
    if (!['available', 'unverified'].includes(reference.availability)) parsed.diagnostics.push({
      code: `ASSET_${reference.availability.toUpperCase()}`, message: `Asset reference is ${reference.availability}`, path: record,
    });
  }
  return references;
}
