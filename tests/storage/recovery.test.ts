import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recoverDatabase } from '../../packages/core/src/storage/recover.js';
import { startCore } from '../../packages/core/src/main.js';
import { httpRuntime, httpCore, finishedJob, submitScan } from '../helpers/http.js';
import { submitCapture } from '../helpers/capture.js';
import { recoveryAssets, assetHashes, semanticSnapshot } from '../helpers/recovery.js';
import { pendingSample, manualSource, realBytes, realSamples, sha256 } from '../helpers/fixtures.js';
import { isolatedRuntime } from '../helpers/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('explicit offline database isolation and file-driven rebuild', () => {
  it.each(['missing', 'corrupt', 'newer_schema'])('restores R1/R2/R3/K1/A1 and captured files from %s with unchanged asset bytes and semantic queries', async scenario => {
    const runtime = await httpRuntime(recoveryAssets); cleanups.push(runtime.cleanup);
    const { config, request, core } = runtime;
    await submitCapture(request, '20_Sources/API/web.md', (await realBytes(realSamples[1]!.path)).toString('utf8'));
    await submitCapture(request, '20_Sources/API/manual.md', manualSource('apimanualword', 'annotation: Saved context\nprocessing_status: archived\n'));
    const first = await submitScan(request); expect(await finishedJob(request, first.job.id)).toMatchObject({ status: 'succeeded', summary: { source_count: 8, knowledge_count: 1 } });
    const before = await semanticSnapshot(request); const hashes = await assetHashes(config.vault_path);
    expect(before.documents['20_Sources/R3/archived.md']).toMatchObject({ processing_status: 'archived' });
    expect(before.documents[realSamples[0]!.path]).toMatchObject({ processing_status: 'pending' });
    expect(before.documents['20_Sources/R2/annotated.md']).toMatchObject({ annotation: 'RecoveryContextR2' });
    await core.close();
    const database = path.join(config.data_dir, 'core.sqlite');
    let recovery;
    if (scenario === 'missing') {
      await rm(database);
      const empty = await httpCore(config); cleanups.push(empty.core.close);
      expect(await (await empty.request('/v1/status')).json()).toMatchObject({ index_generation: 0, counts: { sources: 0, knowledge: 0 } });
      expect(await (await empty.request(`/v1/documents?path=${encodeURIComponent(realSamples[0]!.path)}`)).json()).toMatchObject({ index_stale: true, revision: sha256(await pendingSample(realSamples[0]!)) });
      const scan = await submitScan(empty.request, 'rebuild'); expect(await finishedJob(empty.request, scan.job.id)).toMatchObject({ status: 'succeeded' });
      expect(await semanticSnapshot(empty.request)).toEqual(before); await empty.core.close();
      recovery = { missing_database_initialized_empty: true, explicit_rebuild: true };
    } else {
      if (scenario === 'corrupt') await writeFile(database, 'This is a corrupt isolated SQLite file');
      else { const db = new Database(database); db.pragma('user_version=4'); db.close(); }
      const originalDatabase = await readFile(database);
      await expect(startCore(config)).rejects.toMatchObject({ code: scenario === 'corrupt' ? 'DATABASE_ERROR' : 'SCHEMA_UNSUPPORTED' });
      expect(await readFile(database)).toEqual(originalDatabase);
      const journals = ['core.sqlite-journal', 'core.sqlite-wal', 'core.sqlite-shm'];
      for (const name of journals) await writeFile(path.join(config.data_dir, name), `isolated test ${name}`);
      recovery = await recoverDatabase(config);
      expect(recovery.isolated_files).toEqual(['core.sqlite', ...journals]);
      expect(recovery.job).toMatchObject({ status: 'succeeded', mode: 'rebuild', summary: { source_count: 8, knowledge_count: 1 } });
      expect(await readFile(path.join(recovery.backup_dir, 'core.sqlite'))).toEqual(originalDatabase);
      for (const name of journals) expect(await readFile(path.join(recovery.backup_dir, name), 'utf8')).toBe(`isolated test ${name}`);
      const restored = await httpCore(config); cleanups.push(restored.core.close);
      expect(await semanticSnapshot(restored.request)).toEqual(before); await restored.core.close();
    }
    expect(await assetHashes(config.vault_path)).toEqual(hashes);
    if (process.env.P1_EVIDENCE === '1') {
      await mkdir('.local/p1/evidence', { recursive: true });
      await writeFile(`.local/p1/evidence/t10-${scenario}.json`, JSON.stringify({ scenario, recovery, before, after_semantically_equal: true, before_asset_hashes: hashes, after_asset_hashes: await assetHashes(config.vault_path) }, null, 2));
    }
  }, 90_000);

  it('refuses recovery while Core owns data_dir without moving the database or creating a backup', async () => {
    const { config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
    const database = path.join(config.data_dir, 'core.sqlite'); const hash = sha256(await readFile(database));
    await expect(recoverDatabase(config)).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
    expect(sha256(await readFile(database))).toBe(hash);
    expect((await readdir(config.data_dir)).some(name => name.startsWith('recovery-'))).toBe(false);
  });

  it('preflights the complete database family and rejects a hard-linked journal without moving any file', async () => {
    const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
    await mkdir(isolated.config.data_dir);
    const database = path.join(isolated.config.data_dir, 'core.sqlite'); await writeFile(database, 'corrupt database');
    const journal = path.join(isolated.config.data_dir, 'core.sqlite-journal'); await writeFile(journal, 'original journal');
    await link(journal, path.join(isolated.root, 'journal-alias'));
    await expect(recoverDatabase(isolated.config)).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
    expect(await readFile(database, 'utf8')).toBe('corrupt database'); expect(await readFile(journal, 'utf8')).toBe('original journal');
    expect((await readdir(isolated.config.data_dir)).some(name => name.startsWith('recovery-'))).toBe(false);
  });
});
