import { afterEach, describe, expect, it } from 'vitest';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { copyRealSamples } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() { const result = await httpRuntime(copyRealSamples); cleanups.push(result.cleanup); return result; }

describe('real HTTP scans and Registry queries', () => {
  it('does not scan at startup, merges concurrent matching requests and rejects conflicting modes', async () => {
    const { request } = await fixture();
    expect(await (await request('/v1/status')).json()).toMatchObject({ active_job: null, index_generation: 0, counts: { sources: 0, knowledge: 0 } });
    const [first, second, conflict] = await Promise.all([submitScan(request), submitScan(request), submitScan(request, 'rebuild')]);
    expect(first.status).toBe(202); expect(second.status).toBe(202); expect(conflict.status).toBe(409);
    expect(second.job.id).toBe(first.job.id); expect(second.reused).toBe(true);
    const job = await finishedJob(request, first.job.id);
    expect(job).toMatchObject({ status: 'succeeded', processed_files: 2, summary: { added: 2, source_count: 2, knowledge_count: 0 } });
    const sources = await (await request('/v1/sources?limit=1&offset=1')).json();
    expect(sources).toMatchObject({ total: 2, limit: 1, offset: 1, index_generation: 1 });
    expect(sources.items).toHaveLength(1); expect(sources.items[0]).not.toHaveProperty('body_markdown');
    expect(await (await request('/v1/jobs')).json()).toMatchObject({ total: 1 });
    expect((await request('/v1/jobs/unknown')).status).toBe(404);
    const next = await submitScan(request); expect(next.reused).toBe(false); expect(next.job.id).not.toBe(first.job.id);
    expect((await finishedJob(request, next.job.id)).summary?.unchanged).toBe(2);
  });
  it('reports a task failure while retaining the preceding indexed Sources', async () => {
    const { request, config } = await fixture();
    const first = await submitScan(request); await finishedJob(request, first.job.id);
    await rename(path.join(config.vault_path, '20_Sources'), path.join(config.vault_path, 'offline'));
    const failed = await submitScan(request);
    expect(await finishedJob(request, failed.job.id)).toMatchObject({ status: 'failed', error: { code: 'IO_ERROR' }, summary: null });
    expect(await (await request('/v1/sources')).json()).toMatchObject({ total: 2, index_generation: 1 });
  });
  it('rejects unknown fields and invalid modes, filters Sources by directory segments', async () => {
    const { request } = await fixture();
    for (const body of [{ mode: 'compile' }, { mode: 'refresh', extra: true }]) {
      const response = await request('/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    const first = await submitScan(request); await finishedJob(request, first.job.id);
    expect(await (await request('/v1/sources?path_prefix=20_Sources/Web&source_type=web')).json()).toMatchObject({ total: 2 });
    expect(await (await request('/v1/sources?path_prefix=20_Sources/We')).json()).toMatchObject({ total: 0 });
    expect((await request('/v1/sources?limit=101')).status).toBe(400);
  });
});
