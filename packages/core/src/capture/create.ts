import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, PaperLocatorSchema, type CaptureRequest, type CaptureResponse } from '@engramweave/contracts';
import { Value } from '@sinclair/typebox/value';
import { CoreError } from '../errors.js';
import { markdownPath, resolveVaultDirectory, resolveMarkdown } from '../files/paths.js';
import { readMarkdown } from '../files/read.js';
import { publishFile } from '../files/publication.js';
import { parseMarkdown } from '../source/parse.js';
import { pendingSourceBytes, registeredSourceBytes, compiledSourceBytes } from '../source/properties.js';
import { listDrafts } from '../drafts/files.js';
import { sourceProfileBytes } from '../analysis/selection.js';

async function ensureParent(vault: string, relative: string): Promise<void> {
  try { await resolveVaultDirectory(vault, relative); return; }
  catch (error) { if (!(error instanceof CoreError) || error.code !== 'DOCUMENT_NOT_FOUND') throw error; }
  const parent = path.posix.dirname(relative);
  await ensureParent(vault, parent === '.' ? '' : parent);
  try { await mkdir(path.join(vault, relative)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await resolveVaultDirectory(vault, relative);
}

async function existingMatch(vault: string, relative: string, bytes: Buffer, newOnly = false): Promise<string | null> {
  let filename;
  try { filename = await resolveMarkdown(vault, relative); }
  catch (error) { if (error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; }
  if (newOnly) throw new CoreError('JOB_BUSY', 'Only new Sources can be captured during model work; retry the unchanged request when work finishes', 409);
  const size = (await lstat(filename)).size;
  // Keep conflict behavior for oversized existing files without attempting to read them.
  if (size > LIMITS.markdown_bytes) throw new CoreError('PATH_CONFLICT', 'Capture target already contains different bytes', 409);
  const current = await readMarkdown(vault, relative);
  if (current.bytes.equals(bytes)) return current.revision;
  try {
    if (current.bytes.equals(pendingSourceBytes(relative, bytes))) return current.revision;
    const registered = registeredSourceBytes(relative, bytes);
    if (current.bytes.equals(registered)) return current.revision;
    if (current.bytes.equals(compiledSourceBytes(relative, registered))) {
      const inputRevision = createHash('sha256').update(registered).digest('hex');
      const drafts = await listDrafts(vault, relative);
      if (drafts.items.some(draft => [inputRevision, current.revision].includes(String(draft.metadata.compiled_source_revision)))) return current.revision;
    }
  } catch { /* Unsupported stage edits do not broaden replay matching. */ }
  throw new CoreError('PATH_CONFLICT', 'Capture target already contains different bytes', 409);
}

/** Save validated inline Source bytes; indexing is always a separate explicit scan. */
export async function createCapture(vault: string, input: CaptureRequest, newOnly = false): Promise<CaptureResponse> {
  const relative = markdownPath(input.path);
  if (!relative.startsWith('20_Sources/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Capture requires a Source target', 403);
  const original = Buffer.from(input.markdown, 'utf8');
  const bytes = input.analysis_profile === undefined ? original : sourceProfileBytes(original, input.analysis_profile);
  if (bytes.length > LIMITS.markdown_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'Capture Markdown exceeds the byte limit', 413);
  const parsed = parseMarkdown(relative, bytes);
  const paper = parsed.source_type === 'paper';
  if (parsed.state !== 'ready' || !['web', 'manual', 'paper'].includes(parsed.source_type ?? '') || parsed.asset?.kind !== 'inline_markdown'
    || !(parsed.body_markdown.trim() || paper && parsed.annotation.trim()) || paper && !Value.Check(PaperLocatorSchema, parsed.original_locator)) {
    throw new CoreError('INVALID_SOURCE', 'Capture requires supported inline text; paper needs a Zotero item locator and selected text or comments', 422, { diagnostics: parsed.diagnostics });
  }
  const response = (created: boolean, revision = createHash('sha256').update(bytes).digest('hex')): CaptureResponse => ({ path: relative, revision, created, scan_required: true });
  await ensureParent(vault, path.posix.dirname(relative));
  let existing = await existingMatch(vault, relative, bytes, newOnly);
  if (existing) return response(false, existing);
  if (await publishFile(vault, relative, bytes)) return response(true);
  // Another publisher may have won after the initial existence check.
  existing = await existingMatch(vault, relative, bytes, newOnly);
  if (existing) return response(false, existing);
  throw new CoreError('IO_ERROR', 'Capture target disappeared during publication');
}
