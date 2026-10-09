import type { CompilerSettings } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { compilerResult } from '../compiler/input.js';
import { TransientExecutionError, transientNetwork } from '../processing/retries.js';

export const resultJsonSchema = { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false };
export async function executeApi(settings: CompilerSettings, key: string, prompt: string, signal: AbortSignal, instructions: string) {
  return compilerResult(await executeApiText(settings, key, prompt, signal, instructions, resultJsonSchema, 'compiler_result'), settings.output_format === 'text');
}
export async function executeApiText(settings: CompilerSettings, key: string, prompt: string, signal: AbortSignal, instructions: string, schema: object, name: string): Promise<string> {
  const format = settings.output_format === 'json_schema' ? { type: 'json_schema', json_schema: { name, strict: true, schema } }
    : settings.output_format === 'json_object' ? { type: 'json_object' } : undefined;
  let response: Response;
  try {
    response = await fetch(`${settings.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }], stream: false, ...(format ? { response_format: format } : {}), ...(settings.reasoning_effort !== 'default' ? { reasoning_effort: settings.reasoning_effort } : {}), ...(settings.output_tokens ? { [settings.output_tokens.parameter]: settings.output_tokens.limit } : {}) }),
    });
  } catch (error) {
    if (transientNetwork(error, signal)) throw new TransientExecutionError('API connection temporarily failed or timed out');
    throw new CoreError('EXECUTION_FAILED', 'API connection stopped or failed; check configuration');
  }
  if (!response.ok) {
    const diagnostic = await rejectionDiagnostic(response);
    const message = `API returned HTTP ${response.status}${diagnostic}; ${response.status === 400 ? 'check output format, token budget, reasoning parameters and model context limit' : 'check endpoint, model, authentication or quota'}`;
    if ([429,500,502,503,504].includes(response.status)) {
      const header = response.headers.get('retry-after'); const seconds = header === null ? 0 : Number(header);
      const wait = header === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      throw new TransientExecutionError(message, Math.max(0, Math.min(30_000, Number.isFinite(wait) ? wait : 0)));
    }
    throw new CoreError('EXECUTION_FAILED', message);
  }
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const bytes of response.body ?? []) {
      size += bytes.length;
      if (size > 4_000_000) throw new CoreError('INVALID_MODEL_OUTPUT', 'API response exceeds the limit', 422);
      chunks.push(Buffer.from(bytes));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const choice = value.choices?.[0];
    if (choice?.finish_reason === 'length') throw new CoreError('INVALID_MODEL_OUTPUT', 'API output reached its token limit (finish_reason: length); increase the output budget or reduce requested output and reasoning', 422);
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new CoreError('INVALID_MODEL_OUTPUT', 'API refused or filtered the task result', 422);
    if (choice?.message?.tool_calls?.length) throw new CoreError('INVALID_MODEL_OUTPUT', 'API returned tool calls instead of a task result; this route requires a direct answer', 422);
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw new CoreError('INVALID_MODEL_OUTPUT', 'API returned no task content', 422);
    if (choice.finish_reason !== 'stop') throw new CoreError('INVALID_MODEL_OUTPUT', 'API returned an unsupported or missing finish_reason; expected stop', 422);
    return choice.message.content;
  } catch (error) {
    if (transientNetwork(error, signal)) throw new TransientExecutionError('API response temporarily failed or timed out');
    if (signal.aborted) throw new CoreError('EXECUTION_FAILED', 'API response stopped or exceeded its time limit');
    if (error instanceof CoreError) throw error;
    throw new CoreError('INVALID_MODEL_OUTPUT', 'API returned malformed response JSON or an incompatible response structure', 422);
  }
}

/** Only recognized protocol fields are exposed; provider text may contain prompts or credentials. */
async function rejectionDiagnostic(response: Response): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const bytes of response.body ?? []) {
      size += bytes.length;
      if (size > 16384) return '';
      chunks.push(Buffer.from(bytes));
    }
    const error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error;
    const fields: string[] = [];
    const parameter = typeof error?.param === 'string' ? error.param.split(/[.#/]/)[0] : '';
    if (['model','messages','stream','response_format','reasoning_effort','max_tokens','max_completion_tokens'].includes(parameter)) fields.push(`parameter: ${parameter}`);
    if (error?.code === 'response_format_not_supported') fields.push('code: response_format_not_supported; start the service with --structured-output or explicitly select JSON in text');
    else if (['invalid_request_error','invalid_parameter','unsupported_parameter','invalid_json_schema','unsupported_json_schema','unsatisfiable_json_schema','context_length_exceeded','thinking_budget_capacity_insufficient','conflicting_template_option','model_not_found','invalid_api_key'].includes(error?.code)) fields.push(`code: ${error.code}`);
    return fields.length ? ` (${fields.join('; ')})` : '';
  } catch { return ''; }
}
