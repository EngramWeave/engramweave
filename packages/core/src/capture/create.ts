import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, type CaptureRequest, type CaptureResponse } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { markdownPath, resolveVaultDirectory, resolveMarkdown } from '../files/paths.js';
import { readMarkdown } from '../files/read.js';
import { publishFile } from '../files/publication.js';
import { parseMarkdown } from '../source/parse.js';

async function ensureParent(vault: string, relative: string): Promise<void> {
  try { await resolveVaultDirectory(vault, relative); return; }
  catch (error) { if (!(error instanceof CoreError) || error.code !== 'DOCUMENT_NOT_FOUND') throw error; }
  const parent = path.posix.dirname(relative);
  await ensureParent(vault, parent === '.' ? '' : parent);
  try { await mkdir(path.join(vault, relative)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await resolveVaultDirectory(vault, relative);
}

async function existingMatch(vault: string, relative: string, bytes: Buffer): Promise<boolean> {
  let filename;
  try { filename = await resolveMarkdown(vault, relative); }
  catch (error) { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return false; throw error; }
  if ((await lstat(filename)).size !== bytes.length) throw new CoreError('PATH_CONFLICT', 'Capture target already contains different bytes', 409);
  const current = await readMarkdown(vault, relative);
  if (!current.bytes.equals(bytes)) throw new CoreError('PATH_CONFLICT', 'Capture target already contains different bytes', 409);
  return true;
}

/** Save validated inline Source bytes; indexing is always a separate explicit scan. */
export async function createCapture(vault: string, input: CaptureRequest): Promise<CaptureResponse> {
  const relative = markdownPath(input.path);
  if (!relative.startsWith('20_Sources/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Capture requires a Source target', 403);
  const bytes = Buffer.from(input.markdown, 'utf8');
  if (bytes.length > LIMITS.markdown_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'Capture Markdown exceeds the byte limit', 413);
  const parsed = parseMarkdown(relative, bytes);
  if (parsed.state !== 'ready' || !['web', 'manual'].includes(parsed.source_type ?? '') || parsed.asset?.kind !== 'inline_markdown' || !parsed.body_markdown.trim()) {
    throw new CoreError('INVALID_SOURCE', 'Capture requires a complete web or manual inline Raw Source', 422, { diagnostics: parsed.diagnostics });
  }
  const response = (created: boolean): CaptureResponse => ({ path: relative, revision: createHash('sha256').update(bytes).digest('hex'), created, scan_required: true });
  await ensureParent(vault, path.posix.dirname(relative));
  if (await existingMatch(vault, relative, bytes)) return response(false);
  if (await publishFile(vault, relative, bytes)) return response(true);
  // Another publisher may have won after the initial existence check.
  if (await existingMatch(vault, relative, bytes)) return response(false);
  throw new CoreError('IO_ERROR', 'Capture target disappeared during publication');
}
