import { randomUUID, createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { FileProblem, type FileRead } from './read.js';
import { markdownPath, resolveVaultDirectory } from './paths.js';
import { windowsAttributes } from './windows.js';
import { PropertyNative } from './property-native.js';
import { CoreError } from '../errors.js';

const stemPattern = /^\.engramweave-properties-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const isPropertyJournal = (name: string) => name.endsWith('.json') && stemPattern.test(name.slice(0, -5));
export const isPropertyArtifact = (name: string) => /\.(json|tmp|bak)$/.test(name) && stemPattern.test(name.replace(/\.(json|tmp|bak)$/, ''));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Only Source registration uses this writer; GET and Capture creation remain independent. */
export async function writeSourceProperties(vault: string, relative: string, file: FileRead, bytes: Buffer, native: PropertyNative, onBytes?: (count: number) => void): Promise<FileRead> {
  markdownPath(relative);
  if (!relative.startsWith('20_Sources/')) throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Only Source properties may be normalized');
  return writeLifecycleProperties(vault, relative, file, bytes, native, onBytes);
}

/** Explicit lifecycle actions use the same bounded native commit and recovery protocol. */
export async function writeLifecycleProperties(vault: string, relative: string, file: FileRead, bytes: Buffer, native: PropertyNative, onBytes?: (count: number) => void): Promise<FileRead> {
  markdownPath(relative, true);
  // Native commit locks and validates the entire parent chain before creating any artifact.
  const directory = path.join(vault, path.posix.dirname(relative));
  const stem = `.engramweave-properties-${randomUUID()}`;
  const journal = path.join(directory, `${stem}.json`);
  const after = hash(bytes);
  // The manifest precedes both temp creation and publication; the original is never truncated.
  const manifest = Buffer.from(JSON.stringify({ version: 1, relative, before: file.revision, after }));
  try {
    const committed = await native.run(vault, relative, stem, file.revision, after, hash(manifest), false, { manifest_bytes: manifest.toString('base64'), replacement_bytes: bytes.toString('base64') });
    return { bytes, revision: after, size: bytes.length, mtime: committed.mtime };
  } catch (error) {
    // Restore an absent original or remove verified unused artifacts; never overwrite a changed target.
    try { await recoverPropertyJournal(vault, path.posix.dirname(relative), path.basename(journal), native, hash(manifest), onBytes); }
    catch (recoveryError) {
      if (recoveryError instanceof CoreError) throw recoveryError;
      // Keep uncertain versions and manifest for the next scan.
    }
    if (error instanceof FileProblem || error instanceof CoreError) throw error;
    throw new FileProblem('PROPERTY_WRITE_FAILED', 'invalid', 'Source properties could not be committed; inspect preserved artifacts');
  }
}

export async function recoverPropertyJournal(vault: string, directory: string, name: string, native: PropertyNative, expectedManifest?: string, onBytes?: (count: number) => void): Promise<void> {
  if (!isPropertyJournal(name)) throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Unrecognized property journal');
  const parent = await resolveVaultDirectory(vault, directory);
  const filename = path.join(parent, name);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || (await windowsAttributes([filename]))[0]?.reparse) {
    throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Property journal is unsafe');
  }
  const handle = await open(filename, 'r');
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== info.ino || before.nlink !== 1 || before.size > 4096) throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Property journal identity changed');
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
      onBytes?.(read.bytesRead);
    }
    const after = await handle.stat(); const current = await lstat(filename);
    if (length > 4096 || length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.isSymbolicLink()) {
      throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Property journal changed while reading');
    }
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const manifestHash = hash(bytes);
  if (expectedManifest !== undefined && expectedManifest !== manifestHash) throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Property journal was replaced; preserved for inspection');
  const record: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record || typeof record !== 'object') throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Property journal is invalid');
  const item = record as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'after,before,relative,version' || item.version !== 1 || typeof item.relative !== 'string' || typeof item.before !== 'string' || typeof item.after !== 'string'
    || !/^[a-f0-9]{64}$/.test(item.before) || !/^[a-f0-9]{64}$/.test(item.after)
    || markdownPath(item.relative, true) !== item.relative || path.posix.dirname(item.relative) !== directory) {
    throw new FileProblem('PROPERTY_RECOVERY_CONFLICT', 'invalid', 'Property journal does not match its Source directory');
  }
  await native.run(vault, item.relative, name.slice(0, -5), item.before, item.after, manifestHash, true);
}
