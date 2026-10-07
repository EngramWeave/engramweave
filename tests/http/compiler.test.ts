import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { sourcePath, sourceText } from '../helpers/compiler.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { API } from '@engramweave/contracts';

describe('Compiler HTTP extensions', () => {
  it('validates settings, keeps credentials write-only, exposes retained Drafts and rejects unexpected fields', async () => {
    const runtime = await httpRuntime(async vault => {
      await mkdir(path.join(vault, '20_Sources')); await writeFile(path.join(vault, sourcePath), sourceText);
      await mkdir(path.join(vault, '30_Drafts'));
      await writeFile(path.join(vault, '30_Drafts/retained.md'), '---\ntype: draft\ntitle: User candidate\nsources:\n  - "[[20_Sources/selected.md]]"\n---\n\nExisting user edit.');
    });
    try {
      const scan = await submitScan(runtime.request); expect((await finishedJob(runtime.request, scan.job.id)).status).toBe('succeeded');
      const request = (route: string, body: unknown) => runtime.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const saved = await request('/v1/compiler/settings', { settings: { ...defaultSettings, route: 'api', model: 'fixture-model' }, api_key: 'wire-secret' });
      expect(saved.status).toBe(200);
      const value = await saved.json();
      expect(Value.Check(API.compilerSettingsWrite.schema.response[200], value)).toBe(true);
      expect(value.api_key_configured).toBe(true); expect(JSON.stringify(value)).not.toContain('wire-secret');
      const drafts = await runtime.request(`/v1/drafts?source_path=${encodeURIComponent(sourcePath)}`);
      const list = await drafts.json(); expect(list.items).toHaveLength(1); expect(list.items[0].body).toContain('Existing user edit.');
      expect(Value.Check(API.drafts.schema.response[200], list)).toBe(true);
      const document = await runtime.request('/v1/draft?path=30_Drafts%2Fretained.md');
      expect(Value.Check(API.draft.schema.response[200], await document.json())).toBe(true);
      const current = await (await runtime.request(`/v1/documents?path=${encodeURIComponent(sourcePath)}`)).json();
      const invalid = await request('/v1/compilations', { path: sourcePath, revision: current.revision, request_id: randomUUID(), provider: 'forbidden' });
      expect(invalid.status).toBe(400);
      expect((await runtime.request('/v1/jobs')).status).toBe(200);
      expect((await runtime.request('/v1/draft?path=20_Sources%2Fselected.md')).status).toBe(400);
    } finally { await runtime.cleanup(); }
  }, 30_000);
});
