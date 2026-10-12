import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isolatedRuntime } from '../helpers/runtime.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { executeCodex,executeCodexText } from '../../packages/core/src/execution/codex.js';

describe('Codex subprocess result boundary', () => {
  it('uses the exact task MCP whitelist and rejects foreign namespace or Analyzer write events',async()=>{
    const runtime=await isolatedRuntime();
    try{
      await mkdir(runtime.config.data_dir);vi.stubEnv('NODE_OPTIONS',`--import=${pathToFileURL(path.resolve('tests/helpers/codex-child.mjs')).href}`);
      vi.stubEnv('ENGRAMWEAVE_TEST_CODEX_MODE','mcp');vi.stubEnv('ENGRAMWEAVE_TEST_MCP_SERVER','planning');vi.stubEnv('ENGRAMWEAVE_TEST_MCP_TOOL','write_file');
      const settings={...defaultSettings,codex_path:process.execPath};const capability={command:process.execPath,script:'assigned-mcp.js',env:{ENGRAMWEAVE_ANALYSIS_TOKEN:'private-task-capability'},namespace:'planning' as const,tools:['read_input','write_file']};
      await executeCodexText(settings,runtime.config.data_dir,'{}',AbortSignal.timeout(10000),'Task',{},capability);
      const directory=(await readdir(runtime.config.data_dir)).find(name=>name.startsWith('analyzer-codex-'))!;
      const observed=JSON.parse(await readFile(path.join(runtime.config.data_dir,directory,'answer.json.observed.json'),'utf8'));
      expect(observed.args).toContain('mcp_servers.planning.enabled_tools=["read_input","write_file"]');expect(observed.args).toContain('read-only');
      vi.stubEnv('ENGRAMWEAVE_TEST_MCP_SERVER','analysis');await expect(executeCodexText(settings,runtime.config.data_dir,'{}',AbortSignal.timeout(10000),'Task',{},capability)).rejects.toMatchObject({code:'EXECUTION_FAILED'});
      await expect(executeCodexText(settings,runtime.config.data_dir,'{}',AbortSignal.timeout(10000),'Task',{}, {...capability,namespace:'analysis',tools:['read_input','recall','read_evidence']})).rejects.toMatchObject({code:'EXECUTION_FAILED'});
    }finally{vi.unstubAllEnvs();await runtime.cleanup();}
  });
  it('accepts diagnostics followed by a completed structured result, strips API credentials, and refuses tool events', async () => {
    const runtime = await isolatedRuntime();
    try {
      await mkdir(runtime.config.data_dir);
      vi.stubEnv('NODE_OPTIONS', `--import=${pathToFileURL(path.resolve('tests/helpers/codex-child.mjs')).href}`);
      vi.stubEnv('OPENAI_API_KEY', 'secret-must-not-be-inherited');
      const settings = { ...defaultSettings, codex_path: process.execPath, model: 'simulated-model' };
      const result = await executeCodex(settings, runtime.config.data_dir, '{"annotation":"understanding"}', AbortSignal.timeout(10_000), 'Custom Compiler instructions');
      expect(result).toEqual({ title: 'Simulated child result', body: 'Submitted meaning and Annotation.' });
      const directory = (await readdir(runtime.config.data_dir)).find(name => name.startsWith('compiler-codex-'))!;
      const observed = JSON.parse(await readFile(path.join(runtime.config.data_dir, directory, 'answer.json.observed.json'), 'utf8'));
      expect(observed.apiKeyPresent).toBe(false);
      expect(observed.inputHasAnnotation).toBe(true);
      expect(observed.args).toContain('read-only');
      expect(observed.args).toContain('forced_login_method="chatgpt"');
      vi.stubEnv('ENGRAMWEAVE_TEST_CODEX_MODE', 'tool');
      await expect(executeCodex(settings, runtime.config.data_dir, '{}', AbortSignal.timeout(10_000), 'Custom Compiler instructions')).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
    } finally { vi.unstubAllEnvs(); await runtime.cleanup(); }
  }, 30_000);
});
