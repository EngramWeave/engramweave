import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { analyzerFixture } from '../helpers/analyzer.js';
import { freezeAnalysis } from '../../packages/core/src/analysis/input.js';
import { AnalysisTools, analysisToolBridge } from '../../packages/core/src/analysis/tools.js';
import { analysisOutput } from '../../packages/core/src/analysis/output.js';
import { executeApiText } from '../../packages/core/src/execution/api.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';

describe('Analyzer evidence and executable tool boundary', () => {
  it('permits actual stdio MCP read-only calls and refuses unknown, cross-round, arbitrary path or write arguments', async () => {
    const f = await analyzerFixture(); const controller = new AbortController();
    let bridge: Awaited<ReturnType<typeof analysisToolBridge>> | undefined;
    let client: Client | undefined;
    try {
      const snapshot = await freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings);
      const tools = new AnalysisTools(snapshot, 'review', f.recall, { items: [f.hit], coverage: null, diagnostics: [] }, controller.signal);
      bridge = await analysisToolBridge(tools, controller.signal);
      expect((await fetch(bridge.env.ENGRAMWEAVE_ANALYSIS_URL, { method: 'POST' })).status).toBe(403);
      const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../packages/core/dist/analysis/mcp.js', import.meta.url))], env: { ...(process.env as Record<string,string>), ...bridge.env }, stderr: 'pipe' });
      client = new Client({ name: 'analysis-contract-test', version: '1' }); await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['read_input','recall','read_evidence']);
      const input = await client.callTool({ name: 'read_input', arguments: {} }); expect(input.isError).toBe(false); expect(JSON.stringify(input)).toContain('My understanding');
      expect((await client.callTool({ name: 'recall', arguments: { q: 'condition A' } })).isError).toBe(false);
      expect((await client.callTool({ name: 'read_evidence', arguments: { chunk_id: f.hit.chunk_id } })).isError).toBe(false);
      for (const [name, args] of [['discard_source', { path: f.sourcePath }], ['read_input', { draft_path: '30_Drafts/other.md' }], ['read_evidence', { chunk_id: 'other-round' }], ['recall', { q: 'condition', scope: 'sources' }], ['read_input', { path: '../token' }]] as const) {
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
      }
      expect(tools.observations).toHaveLength(3);
      controller.abort(); await expect(tools.call('read_input', {})).rejects.toThrow();
    } finally { await client?.close(); await bridge?.close(); await f.close(); }
  }, 20_000);
  it('validates provided evidence lines and accepts empty findings without invented relationships', async () => {
    const f = await analyzerFixture();
    try {
      const snapshot = await freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings);
      const evidence = { items: [f.hit], coverage: null, diagnostics: [] };
      const result = { summary: 'Check scope', findings: [{ category: 'scope', message: 'Condition missing', evidence: [{ path: f.libraryPath, revision: f.hit.revision, start_line: 4, end_line: 4 }] }], limitations: [] };
      expect(analysisOutput(JSON.stringify(result), 'review', snapshot, evidence)).toEqual(result);
      for (const citation of [{ path: '40_Knowledge/unread.md', revision: f.hit.revision, start_line: 4, end_line: 4 }, { path: f.libraryPath, revision: f.hit.revision, start_line: 1, end_line: 4 }, { path: f.libraryPath, revision: '0'.repeat(64), start_line: 4, end_line: 4 }]) {
        await expect(async () => analysisOutput(JSON.stringify({ ...result, findings: [{ ...result.findings[0], evidence: [citation] }] }), 'review', snapshot, evidence)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
      }
      expect(analysisOutput('{"summary":"","suggestions":[],"limitations":[]}', 'relation', snapshot, evidence)).toMatchObject({ suggestions: [] });
      expect(() => analysisOutput('{"title":"Body","body":"Must not edit"}', 'review', snapshot, evidence)).toThrow();
    } finally { await f.close(); }
  });
  it('keeps API calls tool-free and rejects incomplete or refused provider output', async () => {
    const { vi } = await import('vitest');
    try {
      for (const message of [{ content: '{}', tool_calls: [{}] }, { content: '{}', refusal: 'refused' }, { content: null }]) {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message }] })));
        await expect(executeApiText(defaultSettings, '', '{}', AbortSignal.timeout(1000), 'Instructions', {}, 'review')).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
      }
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })));
      await expect(executeApiText(defaultSettings, '', '{}', AbortSignal.timeout(1000), 'Instructions', {}, 'review')).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    } finally { vi.unstubAllGlobals(); }
  });
});
