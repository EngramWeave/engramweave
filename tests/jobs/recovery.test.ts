import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, indexMeta } from '../../packages/core/src/storage/database.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { retainFinishedJobs } from '../../packages/core/src/jobs/retention.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { manualSource, sha256, writeDocument } from '../helpers/fixtures.js';
import { standaloneCore } from '../helpers/cli.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { faultChild } from '../helpers/fault-child.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('scan restart and completed Job retention', () => {
  it.each(['queued', 'running'] as const)('interrupts residual %s without automatic retry and retains only the latest 100 terminal Jobs', async status => {
    const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
    await mkdir(isolated.config.data_dir);
    await writeDocument(isolated.config.vault_path, '20_Sources/asset.bin', 'original asset');
    const asset = path.join(isolated.config.vault_path, '20_Sources/asset.bin');
    const hash = sha256(await readFile(asset));
    const db = await openDatabase(isolated.config); cleanups.push(async () => { if (db.open) db.close(); });
    const insert = db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at,finished_at) VALUES(?,'scan_vault','refresh',?,?,?)");
    for (let index = 0; index < 105; index++) {
      const time = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      insert.run(`old-${index}`, index % 2 ? 'failed' : 'succeeded', time, time);
    }
    insert.run('residual', status, new Date().toISOString(), null);
    retainFinishedJobs(db);
    expect(db.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 101 });
    const jobs = new ScanJobs(db, isolated.config.vault_path);
    expect(jobs.get('residual')).toMatchObject({ status: 'interrupted', error: { code: 'CORE_UNAVAILABLE' } });
    expect(jobs.list(100, 0).total).toBe(100);
    expect(jobs.get('old-5')).toBeUndefined(); expect(jobs.get('old-6')).toBeDefined();
    expect(jobs.active()).toBeNull(); expect(indexMeta(db).index_generation).toBe(0);
    const retry = jobs.submit('refresh').job;
    await jobs.close();
    expect(jobs.get(retry.id)).toMatchObject({ status: 'succeeded' });
    expect(jobs.list(100, 0).total).toBe(100); expect(jobs.get('old-6')).toBeUndefined();
    expect(sha256(await readFile(asset))).toBe(hash);
  });

  it.each(['before_commit', 'after_commit'])('survives an actual process termination %s with atomic projection and explicit retry', async phase => {
    const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
    await writeDocument(isolated.config.vault_path, '20_Sources/item.md', manualSource('previousgeneration'));
    const core = await standaloneCore(isolated.root, isolated.config);
    try { const submitted = await submitScan(core.request); expect(await finishedJob(core.request, submitted.job.id)).toMatchObject({ status: 'succeeded' }); }
    finally { await core.close(); }
    await writeDocument(isolated.config.vault_path, '20_Sources/item.md', manualSource('nextgeneration', 'processing_status: pending\n'));
    const filename = path.join(isolated.config.vault_path, '20_Sources/item.md');
    const hash = sha256(await readFile(filename));
    const configFile = path.join(isolated.root, 'fault-config.json'); await writeFile(configFile, JSON.stringify(isolated.config));
    const child = faultChild(path.resolve('tests/helpers/scan-publication-child.mjs'), [configFile, phase]);
    let id: string;
    try { id = (await child.phase(phase)).id!; } finally { await child.kill(); }
    const restarted = await standaloneCore(isolated.root, isolated.config);
    try {
      const persistedJob = await (await restarted.request(`/v1/jobs/${id}`)).json();
      expect(persistedJob).toMatchObject({ status: phase === 'before_commit' ? 'interrupted' : 'succeeded' });
      const status = await (await restarted.request('/v1/status')).json();
      expect(status).toMatchObject({ active_job: null, index_generation: phase === 'before_commit' ? 1 : 2 });
      expect(await (await restarted.request('/v1/search?scope=sources&q=nextgeneration')).json()).toMatchObject({ total: phase === 'before_commit' ? 0 : 1 });
      expect(await (await restarted.request('/v1/search?scope=sources&q=previousgeneration')).json()).toMatchObject({ total: phase === 'before_commit' ? 1 : 0 });
      const retry = await submitScan(restarted.request);
      const retriedJob = await finishedJob(restarted.request, retry.job.id);
      expect(retriedJob).toMatchObject({ status: 'succeeded', summary: { index_generation: phase === 'before_commit' ? 2 : 3 } });
      expect(sha256(await readFile(filename))).toBe(hash);
      if (process.env.P1_EVIDENCE === '1') {
        await mkdir('.local/p1/evidence', { recursive: true });
        await writeFile(`.local/p1/evidence/t07-terminate-${phase}.json`, JSON.stringify({ phase, persistedJob, status, retriedJob, original_file_sha256: hash }, null, 2));
      }
    } finally { await restarted.close(); }
  });
});
