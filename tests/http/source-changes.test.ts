import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { pendingSample, copyRealSamples, realSamples, sha256, writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('handles rename, same-URL copies, invalidation and repair through explicit scans without changing other raw inputs', async () => {
  const runtime = await httpRuntime(copyRealSamples); cleanups.push(runtime.cleanup);
  const { request, config } = runtime;
  const scan = async () => { const submitted = await submitScan(request); return finishedJob(request, submitted.job.id); };
  await scan();
  const original = realSamples[0]!;
  const before = await (await request('/v1/sources')).json();
  const originalId = before.items.find((item: { path: string }) => item.path === original.path).id;
  const moved = '20_Sources/Web/2026-10/moved.md';
  await rename(path.join(config.vault_path, original.path), path.join(config.vault_path, moved));
  await writeDocument(config.vault_path, '20_Sources/Web/2026-10/same-url.md', await readFile(path.join(config.vault_path, moved)));
  const renamed = await scan();
  expect(renamed).toMatchObject({ status: 'succeeded', summary: { added: 2, missing: 1, unchanged: 1 } });
  const sources = await (await request('/v1/sources')).json();
  expect(sources.total).toBe(3);
  expect(sources.items.filter((item: { original_locator: string }) => item.original_locator === original.url)).toHaveLength(2);
  const movedId = sources.items.find((item: { path: string }) => item.path === moved).id;
  expect(movedId).not.toBe(originalId);
  expect(await (await request('/v1/sources?state=missing')).json()).toMatchObject({ items: [{ id: originalId, path: original.path }] });
  const goodBytes = await readFile(path.join(config.vault_path, moved));
  await writeDocument(config.vault_path, moved, goodBytes.toString('utf8').replace(/^---\r?\n/, '---\nprocessing_status: invalid\n'));
  expect((await request(`/v1/documents?path=${encodeURIComponent(moved)}`)).status).toBe(422);
  const invalidated = await scan();
  expect(invalidated).toMatchObject({ summary: { invalid: 1 } });
  const search = await (await request('/v1/search?scope=sources&q=OpenClaw.NET')).json();
  expect(search.items.map((item: { path: string }) => item.path)).toEqual(['20_Sources/Web/2026-10/same-url.md']);
  await writeDocument(config.vault_path, moved, goodBytes);
  const repaired = await scan();
  expect(repaired).toMatchObject({ summary: { updated: 1, invalid: 0 } });
  expect(await (await request('/v1/sources')).json()).toMatchObject({ total: 3 });
  expect((await (await request('/v1/sources')).json()).items.find((item: { path: string }) => item.path === moved).id).toBe(movedId);
  for (const relative of [moved, '20_Sources/Web/2026-10/same-url.md']) expect(sha256(await readFile(path.join(config.vault_path, relative)))).toBe(sha256(await pendingSample(original)));
  expect(sha256(await readFile(path.join(config.vault_path, realSamples[1]!.path)))).toBe(sha256(await pendingSample(realSamples[1]!)));
  if (process.env.P1_EVIDENCE === '1') {
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile('.local/p1/evidence/t07-source-changes.json', JSON.stringify({ renamed, invalidated, repaired, distinct_path_count: sources.total, originalId, movedId, invalid_search_paths: search.items.map((item: { path: string }) => item.path), preserved_hashes: realSamples.map(sample => sample.hash) }, null, 2));
  }
});
