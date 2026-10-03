import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isConfig, type Config } from '@engramweave/contracts';
import { CoreError } from './errors.js';

export const pathKey = (value: string) => path.normalize(value).toLowerCase();
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
}

/** Resolve existing ancestors so a junction cannot disguise data inside the Vault. */
async function canonicalFutureDirectory(value: string): Promise<string> {
  try { return await realpath(value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    const canonicalParent = await canonicalFutureDirectory(parent);
    return path.join(canonicalParent, path.basename(value));
  }
}

export async function validateConfig(input: unknown): Promise<Config> {
  if (!isConfig(input)) throw new CoreError('CONFIG_ERROR', 'Invalid configuration fields', 400);
  if (!path.isAbsolute(input.vault_path) || !path.isAbsolute(input.data_dir)) {
    throw new CoreError('CONFIG_ERROR', 'Configuration directories must be absolute', 400);
  }
  try {
    const vault = await realpath(input.vault_path);
    if (!(await stat(vault)).isDirectory()) throw new Error('not directory');
    const data = await canonicalFutureDirectory(path.resolve(input.data_dir));
    if (containsPath(vault, data) || containsPath(data, vault)) {
      throw new CoreError('CONFIG_ERROR', 'Vault and application data directories must be disjoint', 400);
    }
    try { if (!(await stat(data)).isDirectory()) throw new Error('not directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { ...input, vault_path: vault, data_dir: data };
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError('CONFIG_ERROR', 'Configuration directories are unavailable', 400);
  }
}

export async function loadConfig(filename: string): Promise<Config> {
  let input: unknown;
  try { input = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new CoreError('CONFIG_ERROR', 'Configuration file is unreadable or invalid JSON', 400); }
  return validateConfig(input);
}
