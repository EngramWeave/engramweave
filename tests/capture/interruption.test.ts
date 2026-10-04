import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';
import { faultChild } from '../helpers/fault-child.js';
import { standaloneCore } from '../helpers/cli.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { submitCapture } from '../helpers/capture.js';
import { manualSource, sha256 } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['before_publish', 'after_publish'])('recovers an actual HTTP Capture process termination %s and leaves other temporary names untouched', async phase => {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  const { config, root } = isolated;
  await mkdir(path.join(config.vault_path, '20_Sources'));
  await writeFile(path.join(config.vault_path, '20_Sources/.unrelated.tmp'), 'unrelated');
  const configFile = path.join(root, 'config.json'); await writeFile(configFile, JSON.stringify(config));
  const child = faultChild(path.resolve('tests/helpers/capture-fault-child.mjs'), [configFile, phase]); cleanups.push(child.kill);
  await child.phase('core_ready');
  const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
  const markdown = manualSource('crashreplayword');
  const pending = fetch(`http://127.0.0.1:${config.port}/v1/captures`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: '20_Sources/replay.md', markdown }) }).then(response => response.status, () => 'response_lost');
  await child.phase(phase); await child.kill();
  expect(await pending).toBe('response_lost');
  const target = path.join(config.vault_path, '20_Sources/replay.md');
  if (phase === 'after_publish') expect(await readFile(target, 'utf8')).toBe(markdown);
  else await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  const core = await standaloneCore(root, config); cleanups.push(core.close);
  expect((await readdir(path.join(config.vault_path, '20_Sources'))).filter(name => name.startsWith('.engramweave-capture-'))).toHaveLength(1);
  const replay = await submitCapture(core.request, '20_Sources/replay.md', markdown);
  expect(replay).toMatchObject({ status: phase === 'after_publish' ? 200 : 201, body: { created: phase === 'before_publish', scan_required: true } });
  const scanned = await submitScan(core.request); const job = await finishedJob(core.request, scanned.job.id);
  expect(job).toMatchObject({ status: 'succeeded', summary: { source_count: 1, warnings: expect.arrayContaining([expect.objectContaining({ code: 'CAPTURE_TEMPORARY_REMAINS' })]) } });
  expect(await readFile(path.join(config.vault_path, '20_Sources/.unrelated.tmp'), 'utf8')).toBe('unrelated');
  expect(sha256(await readFile(target))).toBe(sha256(Buffer.from(markdown)));
  if (process.env.P1_EVIDENCE === '1') {
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile(`.local/p1/evidence/t09-${phase}.json`, JSON.stringify({ phase, lost_response: true, replay, job, final_sha256: sha256(Buffer.from(markdown)), unrelated_temporary_preserved: true }, null, 2));
  }
}, 30_000);
