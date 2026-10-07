import { expect, it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';
import { standaloneCore } from '../helpers/cli.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { pendingSample, copyRealSamples, realSamples, sha256, writeDocument } from '../helpers/fixtures.js';

it('registers real Clipper files with only a pending property added through the built standalone Core and reads ordinary Knowledge', async () => {
  const isolated = await isolatedRuntime();
  // Real Clipper artifacts are copied while Core is absent. Browser capture itself is manual.
  await copyRealSamples(isolated.config.vault_path);
  const core = await standaloneCore(isolated.root, isolated.config);
  const evidence: Record<string, unknown> = { run_at: new Date().toISOString(), runtime: 'built standalone Core, real loopback HTTP and SQLite',
    fixture_origin: 'Original R1 Clipper artifacts; the user confirms capture was performed with Core closed', queries: [], document_checks: [] };
  let verified = false;
  try {
    const initialSources = await (await core.request('/v1/sources')).json();
    evidence.initial_sources = initialSources;
    expect(initialSources).toMatchObject({ total: 0, index_generation: 0 });
    const before = await (await core.request(`/v1/documents?path=${encodeURIComponent(realSamples[0]!.path)}`)).json();
    expect(before).toMatchObject({ annotation: '', indexed_revision: null, indexed_at: null, index_stale: true, index_generation: 0 });
    const submitted = await submitScan(core.request);
    expect(submitted.status).toBe(202);
    const firstJob = await finishedJob(core.request, submitted.job.id); evidence.first_job = firstJob;
    expect(firstJob).toMatchObject({ status: 'succeeded', summary: { added: 2, source_count: 2, knowledge_count: 0, index_generation: 1 } });
    for (const [term, field, sample] of [['OpenClaw.NET', '', realSamples[0]!], ['573KB', 'body', realSamples[0]!], ['volatile', '', realSamples[1]!], ['counter++', 'body', realSamples[1]!]] as const) {
      const results = await (await core.request(`/v1/search?scope=sources&q=${encodeURIComponent(term)}${field ? `&fields=${field}` : ''}`)).json();
      expect(results.total).toBe(1); expect(results.items[0].path).toBe(sample.path);
      (evidence.queries as unknown[]).push({ q: term, fields: field || 'default', result: results });
    }
    for (const sample of realSamples) {
      const document = await (await core.request(`/v1/documents?path=${encodeURIComponent(sample.path)}`)).json();
      expect(document).toMatchObject({ kind: 'source', processing_status: 'pending', lifecycle_status: 'active', annotation: '', original_locator: sample.url, index_stale: false, revision: sha256(await pendingSample(sample)), indexed_revision: sha256(await pendingSample(sample)), record_body: null, body: null });
      expect(document.metadata.author).toEqual([sample.author]);
      expect(document.metadata).not.toHaveProperty('annotation');
      expect(document.source_content).not.toContain(document.metadata.description);
      (evidence.document_checks as unknown[]).push({ path: document.path, revision: document.revision, indexed_revision: document.indexed_revision,
        index_stale: document.index_stale, annotation: document.annotation, original_locator: document.original_locator,
        dates_preserved: document.captured_at === '2026-10-03' && document.metadata.published === '2026-10-03',
        processing_status: document.processing_status, processing_status_absent_in_metadata: !Object.hasOwn(document.metadata, 'processing_status'),
        author: document.metadata.author, description_separate: !document.source_content.includes(document.metadata.description) });
    }
    expect(await (await core.request('/v1/search?scope=sources&q=volatile&fields=annotation')).json()).toMatchObject({ total: 0 });
    expect(await (await core.request('/v1/search?q=volatile')).json()).toMatchObject({ total: 0 });
    const ids = (await (await core.request('/v1/sources')).json()).items.map((item: { id: string }) => item.id);
    const repeated = await submitScan(core.request);
    const repeatedJob = await finishedJob(core.request, repeated.job.id); evidence.repeated_job = repeatedJob;
    expect(repeatedJob.summary).toMatchObject({ added: 0, updated: 0, unchanged: 2, index_generation: 2 });
    expect((await (await core.request('/v1/sources')).json()).items.map((item: { id: string }) => item.id)).toEqual(ids);
    // K1 is explicitly constructed ordinary Markdown, not generated or approved knowledge.
    await writeDocument(isolated.config.vault_path, '40_Knowledge/K1.md', '# Existing knowledge\n\nvolatile counter++ 中文知识');
    const withKnowledge = await submitScan(core.request); await finishedJob(core.request, withKnowledge.job.id);
    const all = await (await core.request('/v1/search?scope=all&q=volatile')).json();
    expect(all.total).toBe(2); expect(all.items[0]).toMatchObject({ kind: 'knowledge', path: '40_Knowledge/K1.md' });
    evidence.knowledge_priority_result = all;
    const knowledge = await (await core.request('/v1/documents?path=40_Knowledge/K1.md')).json();
    expect(knowledge).toMatchObject({ kind: 'knowledge', metadata: {}, source_content: null, record_body: null, asset: null, body: '# Existing knowledge\n\nvolatile counter++ 中文知识' });
    for (const sample of realSamples) expect(sha256(await readFile(path.join(isolated.config.vault_path, sample.path)))).toBe(sha256(await pendingSample(sample)));
    evidence.final_asset_hashes = await Promise.all(realSamples.map(async sample => ({ path: sample.path, sha256: sha256(await readFile(path.join(isolated.config.vault_path, sample.path))), original_sha256: sample.hash })));
    verified = true;
  } finally {
    await core.close(); await isolated.cleanup();
    if (verified && process.env.P1_EVIDENCE === '1') {
      const directory = path.resolve('.local/p1/evidence'); await mkdir(directory, { recursive: true });
      evidence.lifecycle_events = core.output().trim().split('\n').map(line => JSON.parse(line));
      evidence.stderr_empty = core.errors() === '';
      await writeFile(path.join(directory, 'checkpoint-a-vertical-slice.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }
});
