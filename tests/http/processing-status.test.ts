import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { pendingSample, archivedSample, copyRealSamples, manualSource, realSamples, sha256, writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('returns current archival separately from the published Registry and checks archived content on refresh', async () => {
  const relative = '20_Sources/R3/archived.md';
  const r3 = await archivedSample();
  const fixedMtime = new Date('2020-01-01T00:00:00Z');
  const { request, config, cleanup } = await httpRuntime(async vault => {
    await copyRealSamples(vault);
    await writeDocument(vault, relative, r3);
    await utimes(path.join(vault, relative), fixedMtime, fixedMtime);
  });
  cleanups.push(cleanup);
  const route = `/v1/documents?path=${encodeURIComponent(relative)}`;
  const unindexed = await (await request(route)).json();
  expect(unindexed).toMatchObject({ processing_status: 'archived', indexed_at: null, indexed_revision: null, index_generation: 0, index_stale: true });
  expect(await (await request('/v1/sources')).json()).toMatchObject({ total: 0, index_generation: 0 });

  const submitted = await submitScan(request);
  const firstJob = await finishedJob(request, submitted.job.id);
  expect(firstJob).toMatchObject({ status: 'succeeded', summary: { added: 3, source_count: 3 } });
  let sources = await (await request('/v1/sources')).json();
  expect(sources.items.find((item: { path: string }) => item.path === relative)).toMatchObject({ state: 'ready', processing_status: 'archived' });
  for (const sample of realSamples) expect(sources.items.find((item: { path: string }) => item.path === sample.path).processing_status).toBe('pending');
  let indexed = await (await request(route)).json();
  expect(indexed).toMatchObject({ processing_status: 'archived', metadata: { processing_status: 'archived' }, revision: sha256(r3), index_stale: false });
  expect(indexed.indexed_at).toEqual(expect.any(String));
  expect(await (await request('/v1/search?scope=sources&q=573KB&path_prefix=20_Sources/R3')).json()).toMatchObject({ total: 1 });
  expect(await (await request('/v1/search?scope=sources&q=archived&fields=metadata')).json()).toMatchObject({ total: 0 });
  expect(sha256(await readFile(path.join(config.vault_path, relative)))).toBe(sha256(r3));

  const repeated = await submitScan(request);
  const repeatedJob = await finishedJob(request, repeated.job.id);
  expect(repeatedJob).toMatchObject({ summary: { unchanged: 3, index_generation: 2 } });
  const repeatedDocument = await (await request(route)).json();
  expect(repeatedDocument).toMatchObject({ processing_status: 'archived', revision: sha256(r3), index_stale: false });
  expect(Date.parse(repeatedDocument.indexed_at)).toBeGreaterThan(Date.parse(indexed.indexed_at));
  const repeatedSources = await (await request('/v1/sources')).json();
  expect(repeatedSources.items).toEqual(sources.items);
  indexed = repeatedDocument; sources = repeatedSources;

  // Only this isolated derived file is edited. Details must not publish the change.
  const edited = Buffer.from(r3.toString('utf8').replace('processing_status: archived', 'processing_status: ""') + '\r\nrefresh_after_archival\r\n');
  await writeDocument(config.vault_path, relative, edited);
  await utimes(path.join(config.vault_path, relative), fixedMtime, fixedMtime);
  const current = await (await request(route)).json();
  expect(current).toMatchObject({ processing_status: null, metadata: { processing_status: '' },
    indexed_at: indexed.indexed_at, indexed_revision: indexed.revision, index_generation: 2, index_stale: true, revision: sha256(edited) });
  expect(await (await request('/v1/sources')).json()).toEqual(sources);
  expect(await (await request('/v1/jobs')).json()).toMatchObject({ total: 2 });
  expect(await (await request('/v1/search?scope=sources&q=refresh_after_archival')).json()).toMatchObject({ total: 0, index_generation: 2 });

  const next = await submitScan(request);
  const updatedJob = await finishedJob(request, next.job.id);
  expect(updatedJob).toMatchObject({ summary: { updated: 1, unchanged: 2, source_count: 3, index_generation: 3 } });
  const refreshed = await (await request(route)).json();
  const normalizedEdited = Buffer.from(edited.toString('utf8').replace('processing_status: ""', 'processing_status: pending'));
  expect(refreshed).toMatchObject({ processing_status: 'pending', index_stale: false, revision: sha256(normalizedEdited), indexed_revision: sha256(normalizedEdited) });
  expect(Date.parse(refreshed.indexed_at)).toBeGreaterThan(Date.parse(indexed.indexed_at));
  expect(await (await request('/v1/search?scope=sources&q=refresh_after_archival')).json()).toMatchObject({ total: 1, index_generation: 3 });
  expect(sha256(await readFile(path.join(config.vault_path, relative)))).toBe(sha256(normalizedEdited));
  for (const sample of realSamples) expect(sha256(await readFile(path.join(config.vault_path, sample.path)))).toBe(sha256(await pendingSample(sample)));
  if (process.env.P1_EVIDENCE === '1') {
    const directory = path.resolve('.local/p1/evidence'); await mkdir(directory, { recursive: true });
    const fields = (document: Record<string, unknown>) => ({ path: document.path, revision: document.revision, indexed_revision: document.indexed_revision,
      processing_status: document.processing_status, indexed_at: document.indexed_at, index_stale: document.index_stale, index_generation: document.index_generation });
    await writeFile(path.join(directory, 'checkpoint-a-revision-archival.json'), JSON.stringify({ run_at: new Date().toISOString(),
      origin: 'R3 is a private derived R1 copy with one pre-set archive line; only the isolated test file is edited',
      first_job: firstJob, repeated_job: repeatedJob, updated_job: updatedJob, indexed_sources: sources,
      unindexed_document: fields(unindexed), indexed_archived_document: fields(indexed), current_before_scan: fields(current), after_refresh: fields(refreshed),
      archive_searchable: true, details_preserve_index: true, fixed_mtime_changes_detected: true,
      derived_initial_sha256: sha256(r3), derived_final_sha256: sha256(edited), real_hashes_unchanged: true }, null, 2) + '\n');
  }
});

it('reports invalid archival values without returning a searchable Source or an archive state', async () => {
  const { request, cleanup } = await httpRuntime(async vault => {
    await writeDocument(vault, '20_Sources/invalid.md', manualSource('never-index-this', 'processing_status: failed\n'));
  });
  cleanups.push(cleanup);
  const response = await request('/v1/documents?path=20_Sources/invalid.md');
  expect(response.status).toBe(422);
  expect((await response.json()).error.details.diagnostics[0].code).toBe('INVALID_PROCESSING_STATUS');
  const submitted = await submitScan(request);
  expect(await finishedJob(request, submitted.job.id)).toMatchObject({ summary: { invalid: 1, source_count: 0 } });
  expect(await (await request('/v1/sources?state=invalid')).json()).toMatchObject({ total: 1, items: [{ state: 'invalid', processing_status: null }] });
  expect(await (await request('/v1/search?scope=sources&q=never-index-this')).json()).toMatchObject({ total: 0 });
});
