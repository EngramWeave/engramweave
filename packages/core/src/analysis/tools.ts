import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import type { SemanticRecall } from '../recall/index.js';
import { CoreError } from '../errors.js';
import type { AnalysisSnapshot, AnalysisEvidence } from './input.js';
import { mergeEvidence } from './context.js';

export const analysisTools = [
  { name: 'read_input', description: 'Read the frozen Source, Annotation and explicit Draft for this round only.', inputSchema: Type.Object({}, { additionalProperties: false }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'recall', description: 'Retrieve bounded current Knowledge/Ideas/Research evidence within this task template scope.', inputSchema: Type.Object({ q: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'read_evidence', description: 'Verify and read only an already selected evidence chunk, never an arbitrary path.', inputSchema: Type.Object({ chunk_id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
];
export class AnalysisTools {
  private calls = 0;
  private bytes = 0;
  readonly observations: { tool: string; arguments: unknown; result: unknown }[] = [];
  constructor(private readonly snapshot: AnalysisSnapshot, private readonly task: 'review' | 'relation', private readonly recall: Pick<SemanticRecall, 'recall' | 'context'>,
    public evidence: AnalysisEvidence, private readonly signal: AbortSignal) {}
  async call(name: string, args: unknown) {
    this.signal.throwIfAborted();
    const tool = analysisTools.find(t => t.name === name);
    if (!tool || !Value.Check(tool.inputSchema, args)) throw new CoreError('VALIDATION_ERROR', 'Tool arguments or capability are not permitted', 400);
    if (++this.calls > 12) throw new CoreError('PAYLOAD_TOO_LARGE', 'Analyzer tool call budget reached', 413);
    let result: unknown;
    if (name === 'read_input') result = this.snapshot.input;
    else if (name === 'recall') {
      const context = this.snapshot.templates[this.task].context;
      const recalled = await this.recall.recall({ q: (args as { q: string }).q, scope: context.scope, limit: context.limit }, this.signal);
      result = { items: recalled.items, coverage: recalled.coverage, diagnostics: recalled.diagnostics };
      this.evidence = mergeEvidence(this.evidence, result as AnalysisEvidence);
    } else {
      const selected = this.evidence.items.find(item => item.chunk_id === (args as { chunk_id: string }).chunk_id);
      if (!selected) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Evidence was not selected in this round', 403);
      result = await this.recall.context([selected]);
    }
    this.signal.throwIfAborted();
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (this.bytes + bytes > 2_000_000 || Buffer.byteLength(JSON.stringify(this.evidence)) > 150_000) throw new CoreError('PAYLOAD_TOO_LARGE', 'Analyzer tool evidence budget reached', 413);
    this.bytes += bytes;
    this.observations.push({ tool: name, arguments: args, result });
    return result;
  }
}
/** A per-task private capability endpoint. It has no Core token or write services. */
export async function analysisToolBridge(tools: AnalysisTools, signal: AbortSignal) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const expected = `Bearer ${token}`; const supplied = request.headers.authorization;
    if (request.method !== 'POST' || request.url !== '/' || request.headers.origin || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { response.writeHead(403).end(); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new Error(); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const result = await tools.call(input.name, input.arguments);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { response.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof CoreError ? { code: error.code, message: error.message } : { code: 'EXECUTION_FAILED', message: 'Analyzer tool stopped or failed' } })); }
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Bridge address unavailable');
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  const abort = () => { server.closeAllConnections(); server.close(); };
  signal.addEventListener('abort', abort, { once: true });
  return { env: { ENGRAMWEAVE_ANALYSIS_URL: `http://127.0.0.1:${address.port}/`, ENGRAMWEAVE_ANALYSIS_TOKEN: token }, async close() { signal.removeEventListener('abort', abort); await close(); } };
}
