import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isolatedRuntime } from '../helpers/runtime.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { executeCodex } from '../../packages/core/src/execution/codex.js';

describe('Codex subprocess result boundary', () => {
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
