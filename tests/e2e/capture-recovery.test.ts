import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';
import { recoverCore, standaloneCore } from '../helpers/cli.js';
import { submitCapture } from '../helpers/capture.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { copyRealSamples, manualSource, realBytes, realSamples, sha256 } from '../helpers/fixtures.js';

it('demonstrates both Capture paths and offline CLI recovery through the built standalone Core', async () => {
  const isolated = await isolatedRuntime();
  await copyRealSamples(isolated.config.vault_path);
  let core = await standaloneCore(isolated.root, isolated.config);
  try {
    const raw = await realBytes(realSamples[0]!.path);
    const web = await submitCapture(core.request, '20_Sources/API/web.md', raw.toString('utf8'));
    const markdown = manualSource('standalonecaptureword', 'annotation: Standalone context\nprocessing_status: archived\n');
    const manual = await submitCapture(core.request, '20_Sources/API/manual.md', markdown);
    expect(web.status).toBe(201); expect(manual.status).toBe(201);
    const scan = await submitScan(core.request); expect(await finishedJob(core.request, scan.job.id)).toMatchObject({ status: 'succeeded', summary: { source_count: 4 } });
    const previous = await (await core.request('/v1/sources')).json();
    await core.close();
    const database = path.join(isolated.config.data_dir, 'core.sqlite');
    await writeFile(database, 'isolated CLI corruption');
    const recovered = await recoverCore(isolated.root, isolated.config);
    expect(recovered.stderr).toBe('');
    expect(recovered.result).toMatchObject({ event: 'core_recovered', isolated_files: ['core.sqlite'], job: { status: 'succeeded', mode: 'rebuild', summary: { source_count: 4 } } });
    expect(await readFile(path.join(recovered.result.backup_dir, 'core.sqlite'), 'utf8')).toBe('isolated CLI corruption');
    core = await standaloneCore(isolated.root, isolated.config);
    const current = await (await core.request('/v1/sources')).json();
    expect(current.items.map((item: { path: string; revision: string; processing_status: string | null }) => [item.path, item.revision, item.processing_status]))
      .toEqual(previous.items.map((item: { path: string; revision: string; processing_status: string | null }) => [item.path, item.revision, item.processing_status]));
    expect(await (await core.request('/v1/search?scope=sources&q=standalonecaptureword')).json()).toMatchObject({ total: 1 });
    const replay = await submitCapture(core.request, manual.body.path, markdown); expect(replay).toMatchObject({ status: 200, body: { created: false, revision: manual.body.revision } });
    for (const sample of realSamples) expect(sha256(await readFile(path.join(isolated.config.vault_path, sample.path)))).toBe(sample.hash);
    if (process.env.P1_EVIDENCE === '1') {
      await mkdir('.local/p1/evidence', { recursive: true });
      await writeFile('.local/p1/evidence/checkpoint-b-standalone.json', JSON.stringify({ run_at: new Date().toISOString(), runtime: 'built standalone Core and offline CLI, real HTTP/SQLite', first_capture_origin: 'User-confirmed real Clipper artifacts copied while Core was absent', web, manual, recovery_cli: recovered.result, before_sources: previous, after_sources: current, replay, raw_hashes: realSamples.map(sample => sample.hash) }, null, 2));
    }
  } finally { await core.close(); await isolated.cleanup(); }
}, 45_000);
