import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { assetBytes, assetChain, assetPath, knowledgePath, recordPath } from '../helpers/assets.js';
import { pendingSample, realSamples, sha256 } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('follows K1 → R1/A1 → Asset and rechecks missing/restored assets with unchanged Record bytes in both scan modes', async () => {
  const { request, config, cleanup } = await httpRuntime(assetChain); cleanups.push(cleanup);
  const document = async (relative: string) => (await request(`/v1/documents?path=${encodeURIComponent(relative)}`)).json();
  const scan = async (mode = 'refresh') => { const result = await submitScan(request, mode); return finishedJob(request, result.job.id); };
  const unindexed = await document(knowledgePath);
  expect(unindexed.original_references.map((reference: { target_path: string; availability: string }) => [reference.target_path, reference.availability])).toEqual([[realSamples[0]!.path, 'available'], [recordPath, 'available']]);
  const record = await document(recordPath);
  expect(record).toMatchObject({ source_content: null, record_body: 'Record description only', annotation: 'User annotation',
    asset: { kind: 'vault_file', locator: assetPath, availability: 'available' },
    original_references: [{ raw: '[[./pixel.png#image|original pixel]]', target_path: assetPath, anchor: 'image', alias: 'original pixel', availability: 'available' }] });
  expect(await document('20_Sources/A1/external.source.md')).toMatchObject({ source_content: null, record_body: 'External record description', asset: { kind: 'external_ref', availability: 'unverified' } });
  expect(await scan()).toMatchObject({ status: 'succeeded', summary: { source_count: 4, knowledge_count: 1, added: 5 } });
  const firstList = await (await request('/v1/sources')).json();
  const firstItem = firstList.items.find((item: { path: string }) => item.path === recordPath);
  const localHash = sha256(await readFile(path.join(config.vault_path, assetPath)));
  expect(localHash).toBe(sha256(assetBytes));
  await rm(path.join(config.vault_path, assetPath));
  const detailMissing = await document(recordPath);
  expect(detailMissing).toMatchObject({ index_stale: false, revision: firstItem.revision, asset: { availability: 'missing' }, diagnostics: [{ code: 'ASSET_MISSING' }] });
  expect((await (await request('/v1/sources')).json()).items.find((item: { path: string }) => item.path === recordPath).asset.availability).toBe('available');
  const missingScan = await scan();
  expect(missingScan).toMatchObject({ summary: { unchanged: 5, invalid: 0, warnings: [{ code: 'ASSET_MISSING', path: recordPath }] } });
  const missingList = await (await request('/v1/sources')).json();
  expect(missingList.items.find((item: { path: string }) => item.path === recordPath)).toMatchObject({ id: firstItem.id, revision: firstItem.revision, state: 'ready', asset: { availability: 'missing' } });
  await writeFile(path.join(config.vault_path, assetPath), assetBytes);
  const restoredScan = await scan('rebuild');
  expect(restoredScan).toMatchObject({ summary: { unchanged: 5, invalid: 0 } });
  const restoredList = await (await request('/v1/sources')).json();
  expect(restoredList.items.find((item: { path: string }) => item.path === recordPath)).toMatchObject({ id: firstItem.id, asset: { availability: 'available' }, diagnostics: [] });
  expect(sha256(await readFile(path.join(config.vault_path, assetPath)))).toBe(localHash);
  for (const sample of realSamples) expect(sha256(await readFile(path.join(config.vault_path, sample.path)))).toBe(sha256(await pendingSample(sample)));
  if (process.env.P1_EVIDENCE === '1') {
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile('.local/p1/evidence/t08-asset-chain.json', JSON.stringify({ unindexed, record, firstList, detailMissing, missingScan, missingList, restoredScan, restoredList, binary_sha256: localHash, raw_sample_hashes: realSamples.map(sample => sample.hash) }, null, 2));
  }
}, 60_000);
