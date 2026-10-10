import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API } from '@engramweave/contracts';
import { httpRuntime, finishedJob } from '../helpers/http.js';
import { pendingSample, copyRealSamples, manualSource, realSamples, sha256 } from '../helpers/fixtures.js';

it('validates wire responses and rejects undeclared inputs across every registered endpoint without asset writes', async () => {
  const runtime = await httpRuntime(copyRealSamples);
  const checks: { route: keyof typeof API; status: number; fields: string[] }[] = [];
  const verify = async (route: keyof typeof API, response: Response) => {
    const schema = (API[route].schema.response as Record<number, TSchema>)[response.status];
    expect(schema, `${route} HTTP ${response.status}`).toBeDefined();
    const body = await response.json();
    expect([...Value.Errors(schema!, body)], `${route} wire response`).toEqual([]);
    checks.push({ route, status: response.status, fields: Object.keys(body) });
    return body;
  };
  const post = (route: string, body: unknown) => runtime.request(route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await verify('health', await runtime.request('/v1/health'));
    await verify('status', await runtime.request('/v1/status'));
    const capture = { path: '20_Sources/API/manual.md', markdown: manualSource('Contract capture') };
    const created = await post('/v1/captures', capture);
    expect(created.status).toBe(201);
    expect(await verify('captures', created)).toMatchObject({ created: true, scan_required: true });
    const replay = await post('/v1/captures', capture);
    expect(replay.status).toBe(200);
    expect(await verify('captures', replay)).toMatchObject({ created: false, scan_required: true });
    const conflict = await post('/v1/captures', { ...capture, markdown: manualSource('Different bytes') });
    expect(conflict.status).toBe(409);
    expect(await verify('captures', conflict)).toMatchObject({ error: { code: 'PATH_CONFLICT' } });

    const scan = await post('/v1/scans', { mode: 'refresh' });
    expect(scan.status).toBe(202);
    const submitted = await verify('scans', scan);
    expect(await finishedJob(runtime.request, submitted.job.id)).toMatchObject({ status: 'succeeded' });
    await verify('job', await runtime.request(`/v1/jobs/${submitted.job.id}`));
    for (const route of ['jobs', 'sources', 'search'] as const) {
      const query = route === 'search' ? 'scope=sources&q=volatile&' : '';
      const page = await verify(route, await runtime.request(`/v1/${route}?${query}limit=1&offset=0`));
      expect(page).toMatchObject({ limit: 1, offset: 0 });
      expect(page.items).toHaveLength(1);
      const empty = await verify(route, await runtime.request(`/v1/${route}?${query}limit=1&offset=100`));
      expect(empty.items).toEqual([]);
      expect(empty.total).toBe(page.total);
      for (const invalid of ['limit=101', 'offset=-1', 'offset=1.5']) {
        const response = await runtime.request(`/v1/${route}?${query}${invalid}`);
        expect(response.status).toBe(400);
        expect(await verify(route, response)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      }
    }
    await verify('documents', await runtime.request(`/v1/documents?path=${encodeURIComponent(realSamples[0]!.path)}`));

    for (const route of Object.keys(API) as (keyof typeof API)[]) {
      const url = API[route].url.replace(':id', submitted.job.id);
      const query = route === 'documents' ? `path=${encodeURIComponent(realSamples[0]!.path)}&` : route === 'search' ? 'scope=sources&q=volatile&' : '';
      const response = API[route].method === 'POST'
        ? await post(url, { ...(route === 'scans' ? { mode: 'refresh' } : capture), undeclared: 'private-input' })
        : await runtime.request(`${url}?${query}undeclared=private-input`);
      expect(response.status, route).toBe(400);
      const error = await verify(route, response);
      expect(error).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(JSON.stringify(error)).not.toContain('private-input');
      expect(JSON.stringify(error)).not.toContain(runtime.config.vault_path);
    }
    expect(new Set(checks.map(check => check.route)).size).toBe(44);
    expect((await (await runtime.request('/v1/jobs')).json()).total).toBe(1);
    expect(await readFile(path.join(runtime.config.vault_path, capture.path), 'utf8')).toBe(capture.markdown.replace('---\n', '---\nprocessing_status: pending\n'));
    const hashes = [];
    for (const sample of realSamples) {
      const actual = sha256(await readFile(path.join(runtime.config.vault_path, sample.path)));
      expect(actual).toBe(sha256(await pendingSample(sample)));
      hashes.push({ path: sample.path, before_sha256: sample.hash, after_sha256: actual });
    }
    if (process.env.P1_EVIDENCE === '1') {
      await mkdir('.local/p1/evidence', { recursive: true });
      await writeFile('.local/p1/evidence/t13-api-contracts.json', `${JSON.stringify({ run_at: new Date().toISOString(), runtime: 'real loopback HTTP, isolated NTFS and SQLite', checks, unchanged_raw_assets: hashes, jobs_after_rejected_requests: 1 }, null, 2)}\n`);
    }
  } finally { await runtime.cleanup(); }
});
