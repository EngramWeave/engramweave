import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { parseDocument } from 'yaml';
import { CoreError } from '../errors.js';
import { analysisTemplatePath, resolveVaultDirectory } from '../files/paths.js';
import { readMarkdown } from '../files/read.js';
import { publishFile } from '../files/publication.js';
import { writeLifecycleProperties, isPropertyJournal, recoverPropertyJournal } from '../files/properties.js';
import { PropertyNative } from '../files/property-native.js';

const ContextSchema = Type.Object({ scope: Type.Union(['all','knowledge','ideas','research'].map(v => Type.Literal(v))), limit: Type.Integer({ minimum: 1, maximum: 20 }), required: Type.Boolean() }, { additionalProperties: false });
export function parseTemplate(content: string) {
  if (!content.trim() || Buffer.byteLength(content) > 64000) throw new CoreError('CONFIG_ERROR', 'Analyzer template must contain 1–64000 UTF-8 bytes', 400);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) throw new CoreError('CONFIG_ERROR', 'Analyzer template needs context YAML and instructions', 400);
  const yaml = parseDocument(match[1]!, { version: '1.2', schema: 'core', uniqueKeys: true });
  const data = yaml.toJS({ maxAliasCount: 0 });
  if (yaml.errors.length || yaml.warnings.length || !data || Object.keys(data).join(',') !== 'context' || !Value.Check(ContextSchema, data.context) || !match[2]!.trim()) throw new CoreError('CONFIG_ERROR', 'Analyzer context requires scope, limit and required fields', 400);
  return { instructions: match[2]!, context: data.context as { scope: 'all' | 'knowledge' | 'ideas' | 'research'; limit: number; required: boolean } };
}
export async function loadAnalysisTemplate(vault: string, relative: string) {
  if (!analysisTemplatePath(relative)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Only Analyzer templates are permitted', 403);
  const file = await readMarkdown(vault, relative);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { throw new CoreError('CONFIG_ERROR', 'Analyzer template is not UTF-8', 400); }
  return { path: relative, revision: file.revision, content, ...parseTemplate(content) };
}
export async function analysisTemplates(vault: string) {
  for (const relative of ['90_System', '90_System/Prompts', '90_System/Prompts/Review', '90_System/Prompts/Relation']) {
    await resolveVaultDirectory(vault, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
    await mkdir(path.join(vault, relative)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await resolveVaultDirectory(vault, relative);
  }
  const native = new PropertyNative();
  try {
    for (const task of ['Review','Relation']) {
      const directory = `90_System/Prompts/${task}`;
      const names = await readdir(await resolveVaultDirectory(vault, directory));
      const journals = names.filter(isPropertyJournal);
      if (journals.length > 100 || names.length > 100) throw new CoreError('PAYLOAD_TOO_LARGE', 'Too many Analyzer template files', 413);
      for (const name of journals) await recoverPropertyJournal(vault, directory, name, native);
      for (const name of ['Knowledge', 'Academic']) {
        const relative = `${directory}/${name}.md`;
        try { await readMarkdown(vault, relative); }
        catch (error) { if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error; await publishFile(vault, relative, await readFile(new URL(`../../templates/${task}-${name}.md`, import.meta.url))); }
      }
    }
  } finally { await native.close(); }
  const items = [];
  for (const task of ['Review','Relation']) {
    const directory = `90_System/Prompts/${task}`;
    for (const name of await readdir(await resolveVaultDirectory(vault, directory))) if (analysisTemplatePath(`${directory}/${name}`)) {
      const file = await readMarkdown(vault, `${directory}/${name}`);
      if (file.size > 64000) throw new CoreError('CONFIG_ERROR', 'Analyzer template exceeds its size bound', 400);
      items.push({ path: `${directory}/${name}`, revision: file.revision, content: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) });
    }
  }
  return { items };
}
export async function saveAnalysisTemplate(vault: string, input: { path: string; revision: string; content: string }) {
  parseTemplate(input.content);
  if (!analysisTemplatePath(input.path)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Only Analyzer templates may be edited', 403);
  const file = await readMarkdown(vault, input.path);
  if (file.revision !== input.revision) throw new CoreError('SOURCE_CHANGED', 'Template changed; reload before saving', 409);
  const native = new PropertyNative();
  try { const next = await writeLifecycleProperties(vault, input.path, file, Buffer.from(input.content), native); return { ...input, revision: next.revision }; }
  finally { await native.close(); }
}
