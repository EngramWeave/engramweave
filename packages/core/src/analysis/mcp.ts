import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { analysisTools } from './tools.js';

const url = process.env.ENGRAMWEAVE_ANALYSIS_URL;
const token = process.env.ENGRAMWEAVE_ANALYSIS_TOKEN;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) || !token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Private analysis capability required');
const server = new Server({ name: 'engramweave-analysis', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: analysisTools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    if (!analysisTools.some(t => t.name === request.params.name)) throw new Error('Unavailable tool');
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments ?? {} }), signal: AbortSignal.timeout(120_000) });
    return { content: [{ type: 'text' as const, text: await response.text() }], isError: !response.ok };
  } catch { return { content: [{ type: 'text' as const, text: 'Tool unavailable or outside this analysis capability.' }], isError: true }; }
});
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void server.close(); });
