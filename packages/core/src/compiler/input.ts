import { Value } from '@sinclair/typebox/value';
import { CompilerResultSchema, type CompilerResult } from '@engramweave/contracts';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown } from '../source/parse.js';
import { CoreError } from '../errors.js';


export async function compilerInput(vault: string, relative: string, revision?: string) {
  if (!relative.startsWith('20_Sources/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Compilation requires a Source path', 403);
  if (/[\[\]#|]/.test(relative)) throw new CoreError('PATH_CONFLICT', 'Source filename cannot form an unambiguous Wiki Link', 409);
  const file = await readMarkdown(vault, relative);
  const parsed = parseMarkdown(relative, file.bytes);
  if (revision !== undefined && file.revision !== revision) throw new CoreError('SOURCE_CHANGED', 'Source changed; reload it before compilation', 409);
  if (parsed.state !== 'ready' || !['pending', 'compiled'].includes(parsed.processing_status ?? '') || parsed.lifecycle_status !== 'active') throw new CoreError('INVALID_SOURCE', 'Compilation requires an active, valid pending or compiled Source', 422);
  if (parsed.asset?.kind !== 'inline_markdown' || (!parsed.body_markdown.trim() && !parsed.annotation.trim())) throw new CoreError('UNSUPPORTED_CONTENT', 'This Source has no supported submitted text; asset references are not extracted automatically', 422);
  const prompt = JSON.stringify({ submitted_content: parsed.body_markdown, annotation: parsed.annotation, source_title: parsed.title, original_locator: parsed.original_locator });
  if (Buffer.byteLength(prompt) > 1_000_000) throw new CoreError('PAYLOAD_TOO_LARGE', 'Compiler input exceeds the text budget', 413);
  return { file, prompt };
}
export function compilerResult(text: string, allowFence = false): CompilerResult {
  if (allowFence) text = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)?.[1] ?? text;
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new CoreError('INVALID_MODEL_OUTPUT', 'Compiler did not return a JSON result', 422); }
  if (!Value.Check(CompilerResultSchema, result) || !result.title.trim() || !result.body.trim() || /[\r\n\x00-\x1f]/.test(result.title) || Buffer.byteLength(result.body) > 1_000_000) throw new CoreError('INVALID_MODEL_OUTPUT', 'Compiler result requires only a nonempty title and Markdown body within the output budget', 422);
  return result;
}
