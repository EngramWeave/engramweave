import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LIMITS } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { resolveMarkdown } from './paths.js';

export class FileProblem extends Error {
  constructor(public readonly code: string, public readonly state: 'invalid' | 'unsupported', message: string) { super(message); }
}
export interface FileRead { bytes: Buffer; revision: string; size: number; mtime: number }
const sameObservation = (a: { size: number; mtimeMs: number; ctimeMs: number; ino: number }, b: typeof a) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

export async function readMarkdown(vault: string, relative: string, attributesChecked = false, onBytes?: (count: number) => void): Promise<FileRead> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const filename = await resolveMarkdown(vault, relative, attributesChecked);
    const handle = await open(filename, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Only regular files can be read', 403);
      if (before.size > LIMITS.markdown_bytes) throw new FileProblem('FILE_TOO_LARGE', 'unsupported', 'Markdown exceeds the file size limit');
      // Read at most the limit plus one byte, including when a file grows during reading.
      const buffer = Buffer.alloc(Math.min(before.size + 1, LIMITS.markdown_bytes + 1));
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
        onBytes?.(result.bytesRead);
      }
      const after = await handle.stat();
      const pathInfo = await lstat(filename);
      if (pathInfo.isSymbolicLink()) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Document became a linked path', 403);
      if (length > LIMITS.markdown_bytes) throw new FileProblem('FILE_TOO_LARGE', 'unsupported', 'Markdown exceeds the file size limit');
      if (!sameObservation(before, after) || !sameObservation(after, pathInfo) || length !== after.size) continue;
      const bytes = buffer.subarray(0, length);
      return { bytes, revision: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mtime: after.mtimeMs };
    } finally { await handle.close(); }
  }
  throw new FileProblem('FILE_UNSTABLE', 'invalid', 'Document changed during both read attempts');
}
