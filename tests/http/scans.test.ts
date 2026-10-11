import { afterEach, describe, expect, it, vi } from 'vitest';
import { rename, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { copyRealSamples } from '../helpers/fixtures.js';
import * as parsing from '../../packages/core/src/source/parse.js';
import { VaultChanges } from '../../packages/core/src/discovery/changes.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() { const result = await httpRuntime(copyRealSamples); cleanups.push(result.cleanup); return result; }

describe('real HTTP scans and Registry queries', () => {
  it('manually reconciles all files with valid parse reuse and does not reuse an incremental task for it', async () => {
    const { request, config } = await fixture();
    await finishedJob(request, (await submitScan(request)).job.id);
    await finishedJob(request, (await submitScan(request)).job.id);
    const full = async () => {
      const response = await request('/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'refresh', force_full: true }) });
      return { status: response.status, ...await response.json() };
    };
    const parse = vi.spyOn(parsing, 'parseMarkdown');
    const [first, duplicate, incompatible] = await Promise.all([full(), full(), submitScan(request)]);
    expect(first.status).toBe(202); expect(duplicate).toMatchObject({ status: 202, reused: true, job: { id: first.job.id } });
    expect(incompatible.status).toBe(409);
    expect(await finishedJob(request, first.job.id)).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'manual_reconciliation', read_files: 2, unchanged: 2 } });
    expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
    expect(await finishedJob(request, (await submitScan(request)).job.id)).toMatchObject({ summary: { scan_strategy: 'incremental', read_files: 0 } });
    // A missed notification must not prevent an explicit full check from seeing current bytes.
    const source = (await (await request('/v1/sources')).json()).items[0];
    const target = path.join(config.vault_path, source.path);
    await writeFile(target, Buffer.concat([await readFile(target), Buffer.from('\nmanual_full_check_change\n')]));
    vi.spyOn(VaultChanges.prototype, 'capture').mockResolvedValueOnce({ paths: [], reason: null });
    expect(await finishedJob(request, (await full()).job.id)).toMatchObject({ status: 'succeeded', summary: { read_files: 2, updated: 1 } });
    expect(await (await request('/v1/search?scope=sources&q=manual_full_check_change')).json()).toMatchObject({ total: 1 });
    const rebuildParsing = vi.spyOn(parsing, 'parseMarkdown');
    expect(await finishedJob(request, (await submitScan(request, 'rebuild')).job.id)).toMatchObject({ status: 'succeeded', summary: { scan_reason: 'explicit_rebuild', read_files: 2 } });
    expect(rebuildParsing).toHaveBeenCalledTimes(2);
  });
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
    for (const body of [{ mode: 'compile' }, { mode: 'refresh', extra: true }, { mode: 'refresh', force_full: 'true' }, { mode: 'rebuild', force_full: true }]) {
      const response = await request('/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    const first = await submitScan(request); await finishedJob(request, first.job.id);
    expect(await (await request('/v1/sources?path_prefix=20_Sources/Web&source_type=web')).json()).toMatchObject({ total: 2 });
    expect(await (await request('/v1/sources?path_prefix=20_Sources/We')).json()).toMatchObject({ total: 0 });
    expect((await request('/v1/sources?limit=101')).status).toBe(400);
  });
});
