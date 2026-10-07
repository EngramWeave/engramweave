import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedRuntime } from '../helpers/runtime.js';
import { defaultSettings, ExecutionSettings } from '../../packages/core/src/execution/settings.js';

describe('Execution settings and credentials', () => {
  it('persists settings separately, protects a key with Windows DPAPI and never returns it', async () => {
    const runtime = await isolatedRuntime();
    try {
      await mkdir(runtime.config.data_dir);
      const settings = new ExecutionSettings(runtime.config.data_dir);
      expect((await settings.read()).api_key_configured).toBe(false);
      const key = 'isolated-test-key-DO-NOT-SEND';
      const saved = await settings.save({ ...defaultSettings, route: 'api', model: 'fixture-model' }, key);
      expect(saved.api_key_configured).toBe(true);
      expect(JSON.stringify(saved)).not.toContain(key);
      expect(await settings.apiKey()).toBe(key);
      expect(await readFile(path.join(runtime.config.data_dir, 'compiler-api-key.dpapi'), 'utf8')).not.toContain(key);
      expect((await new ExecutionSettings(runtime.config.data_dir).read()).settings.model).toBe('fixture-model');
      const switched = await settings.save({ ...defaultSettings, route: 'api', model: 'other-model', endpoint: 'http://127.0.0.1:8094/v1' });
      expect(switched.api_key_configured).toBe(false);
      expect(await settings.apiKey('http://127.0.0.1:8094/v1')).toBe('');
      await expect(settings.apiKey('https://other-provider.example/v1')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
      await expect(settings.save({ ...defaultSettings, endpoint: 'https://user:password@example.com' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    } finally { await runtime.cleanup(); }
  }, 30_000);
});
