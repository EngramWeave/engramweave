import type { CompilerSettings } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { compilerResult, instructions } from '../compiler/input.js';

export const resultJsonSchema = { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false };
export async function executeApi(settings: CompilerSettings, key: string, prompt: string, signal: AbortSignal) {
  const format = settings.output_format === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'compiler_result', strict: true, schema: resultJsonSchema } }
    : settings.output_format === 'json_object' ? { type: 'json_object' } : undefined;
  let response: Response;
  try {
    response = await fetch(`${settings.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }], stream: false, ...(format ? { response_format: format } : {}), ...(settings.reasoning_effort !== 'default' ? { reasoning_effort: settings.reasoning_effort } : {}) }),
    });
  } catch { throw new CoreError('EXECUTION_FAILED', 'API connection stopped, timed out or failed'); }
  if (!response.ok) { await response.body?.cancel(); throw new CoreError('EXECUTION_FAILED', `API returned HTTP ${response.status}; check endpoint, model, authentication or quota`); }
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const bytes of response.body ?? []) {
      size += bytes.length;
      if (size > 4_000_000) throw new CoreError('INVALID_MODEL_OUTPUT', 'API response exceeds the limit', 422);
      chunks.push(Buffer.from(bytes));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const choice = value.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string') throw new Error('incomplete');
    return compilerResult(choice.message.content, settings.output_format === 'text');
  } catch (error) {
    if (signal.aborted) throw new CoreError('EXECUTION_FAILED', 'API response stopped or exceeded its time limit');
    if (error instanceof CoreError) throw error;
    throw new CoreError('INVALID_MODEL_OUTPUT', 'API returned an incomplete, refused or invalid Compiler result', 422);
  }
}
