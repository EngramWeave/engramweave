import path from 'node:path';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { SCAN_ROOTS } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { containsPath, pathKey } from '../config.js';
import { windowsAttributes } from './windows.js';

export const documentPathKey = (value: string) => value.toLowerCase();
export const excludedName = (name: string) => name.startsWith('.') || name.startsWith('~') || /(?:\.tmp|\.temp|\.swp|~)$/i.test(name);

export function normalizeVaultPath(input: string): string {
  const parts = input.split('/');
  if (!input || /[\\:\x00-\x1f]/.test(input) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new CoreError('PATH_OUTSIDE_SCOPE', 'Invalid Vault-relative path', 403);
  }
  return parts.join('/');
}

export function markdownPath(input: string): string {
  const normalized = normalizeVaultPath(input);
  const parts = normalized.split('/');
  if (!SCAN_ROOTS.includes(parts[0] as typeof SCAN_ROOTS[number]) || parts.length < 2 || !/\.md$/i.test(normalized) || parts.some(excludedName)) {
    throw new CoreError('PATH_OUTSIDE_SCOPE', 'Path is outside the supported Markdown scope', 403);
  }
  return normalized;
}

/** Both scans and detail reads check each path segment without following links. */
export async function resolveMarkdown(vault: string, input: string, nativeAttributesChecked = false): Promise<string> {
  return resolveVaultFile(vault, markdownPath(input), nativeAttributesChecked);
}

/** Asset checks share the same containment and native attribute boundary as documents. */
export async function resolveVaultFile(vault: string, input: string, nativeAttributesChecked = false): Promise<string> {
  return resolveVaultEntry(vault, input, false, nativeAttributesChecked);
}

export async function resolveVaultDirectory(vault: string, input: string): Promise<string> {
  return resolveVaultEntry(vault, input, true, false);
}

async function resolveVaultEntry(vault: string, input: string, directory: boolean, nativeAttributesChecked: boolean): Promise<string> {
  const relative = directory && input === '' ? '' : normalizeVaultPath(input);
  if (relative.split('/').some(excludedName)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Excluded paths are not permitted', 403);
  const parts = relative === '' ? [] : relative.split('/');
  const absolute = path.join(vault, ...parts);
  if (!containsPath(vault, absolute)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Path escapes the Vault', 403);
  const segments: string[] = [vault];
  let current = vault;
  for (const part of parts) { current = path.join(current, part); segments.push(current); }
  try {
    for (const [index, segment] of segments.entries()) {
      const info = await lstat(segment);
      if (info.isSymbolicLink() || (directory || index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new CoreError('PATH_OUTSIDE_SCOPE', 'Linked or special paths are not permitted', 403);
      }
      if (!nativeAttributesChecked && index > 0 && (await readdir(path.dirname(segment))).filter(name => name.toLowerCase() === path.basename(segment).toLowerCase()).length > 1) {
        throw new CoreError('PATH_OUTSIDE_SCOPE', 'Case-folded path is ambiguous', 403, { reason: 'ambiguous' });
      }
    }
    if (!nativeAttributesChecked && (await windowsAttributes(segments)).some(item => item.reparse || item.hidden)) {
      throw new CoreError('PATH_OUTSIDE_SCOPE', 'Hidden or reparse paths are not permitted', 403);
    }
    const resolved = await realpath(absolute);
    if (!containsPath(vault, resolved) || pathKey(resolved) !== pathKey(absolute)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Resolved path differs from the requested path', 403);
    return absolute;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CoreError('DOCUMENT_NOT_FOUND', 'Document does not exist', 404);
    throw error;
  }
}
