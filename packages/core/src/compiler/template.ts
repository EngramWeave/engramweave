import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CoreError } from '../errors.js';
import { resolveVaultDirectory } from '../files/paths.js';
import { readMarkdown } from '../files/read.js';
import { publishFile } from '../files/publication.js';

export const compilerTemplatePath = '90_System/Prompts/Compiler.md';
/** Seed once without replacing user content; freeze the current template for each request. */
export async function loadCompilerTemplate(vault: string) {
  await resolveVaultDirectory(vault, '');
  for (const relative of ['90_System', '90_System/Prompts']) {
    await mkdir(path.join(vault, relative)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await resolveVaultDirectory(vault, relative);
  }
  try { await readMarkdown(vault, compilerTemplatePath); }
  catch (error) {
    if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error;
    await publishFile(vault, compilerTemplatePath, await readFile(new URL('../../templates/Compiler.md', import.meta.url)));
  }
  const file = await readMarkdown(vault, compilerTemplatePath);
  let instructions: string;
  try { instructions = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
  catch { throw new CoreError('CONFIG_ERROR', 'Compiler template must be valid UTF-8', 400); }
  if (!instructions.trim() || file.size > 64_000) throw new CoreError('CONFIG_ERROR', 'Compiler template must contain 1–64000 UTF-8 bytes', 400);
  return { instructions, revision: file.revision };
}
