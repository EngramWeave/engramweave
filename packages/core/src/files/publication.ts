import { randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CoreError } from '../errors.js';
import { resolveVaultDirectory } from './paths.js';

export const isCaptureTemporaryName = (name: string) => /^\.engramweave-capture-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.test(name);

/** The NTFS hard-link operation fails if final already exists; never use an overwrite fallback. */
export async function publishFile(vault: string, relative: string, bytes: Buffer): Promise<boolean> {
  const parent = path.posix.dirname(relative);
  const directory = await resolveVaultDirectory(vault, parent);
  const directoryIdentity = (await lstat(directory)).ino;
  const temporary = path.join(directory, `.engramweave-capture-${randomUUID()}.tmp`);
  let temporaryIdentity: number | undefined;
  const checkParent = async () => {
    await resolveVaultDirectory(vault, parent);
    if ((await lstat(directory)).ino !== directoryIdentity) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Capture parent identity changed', 403);
  };
  try {
    const handle = await open(temporary, 'wx');
    try {
      temporaryIdentity = (await handle.stat()).ino;
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await checkParent();
    const temporaryInfo = await lstat(temporary);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || temporaryInfo.ino !== temporaryIdentity || temporaryInfo.nlink !== 1 || temporaryInfo.size !== bytes.length) {
      throw new CoreError('IO_ERROR', 'Capture temporary file identity changed before publication');
    }
    try { await link(temporary, path.join(directory, path.posix.basename(relative))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    return true;
  } finally {
    // Cleanup is limited to the exact temporary inode created by this request.
    if (temporaryIdentity !== undefined) {
      try {
        await checkParent();
        const info = await lstat(temporary);
        if (info.isFile() && !info.isSymbolicLink() && info.ino === temporaryIdentity) await unlink(temporary);
      } catch { /* Leave uncertain residue for explicit scan diagnostics, never remove another file. */ }
    }
  }
}
