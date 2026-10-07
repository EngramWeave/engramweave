import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';
import { standaloneCore } from '../helpers/cli.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { manualSource, writeDocument, sha256 } from '../helpers/fixtures.js';
import { assetHashes } from '../helpers/recovery.js';

it('keeps user Draft, Knowledge and configuration bytes unchanged when a Source edit waits for explicit scanning', async () => {
  const isolated = await isolatedRuntime();
  const initial = manualSource('Before edit', 'processing_status: pending\n');
  const edited = manualSource('EditedSourceOnlyP1', 'processing_status: pending\n');
  await writeDocument(isolated.config.vault_path, '20_Sources/manual.md', initial);
  await writeDocument(isolated.config.vault_path, '40_Knowledge/K1.md', '---\ntags: [ExistingKnowledgeTag]\n---\n# Existing knowledge\nExistingKnowledgeWord');
  await writeDocument(isolated.config.vault_path, '30_Drafts/user-draft.md', '# User draft\nKeep exactly as written.\r\n');
  await writeDocument(isolated.config.vault_path, '90_System/user-config.json', '{"user":"retained"}\r\n');
  const before = await assetHashes(isolated.config.vault_path);
  const core = await standaloneCore(isolated.root, isolated.config);
  try {
    const first = await submitScan(core.request);
    expect(await finishedJob(core.request, first.job.id)).toMatchObject({ status: 'succeeded', summary: { source_count: 1, knowledge_count: 1 } });
    const initialStatus = await (await core.request('/v1/status')).json();
    const initialJobs = await (await core.request('/v1/jobs')).json();
    const knowledge = await (await core.request('/v1/documents?path=40_Knowledge/K1.md')).json();
    expect(knowledge).toMatchObject({ kind: 'knowledge', metadata: { tags: ['ExistingKnowledgeTag'] }, index_stale: false });
    for (const query of ['q=ExistingKnowledgeWord&fields=body', 'tag=ExistingKnowledgeTag&fields=metadata']) {
      const result = await (await core.request(`/v1/search?${query}`)).json();
      expect(result).toMatchObject({ total: 1, items: [{ kind: 'knowledge', path: '40_Knowledge/K1.md' }] });
    }
    await writeDocument(isolated.config.vault_path, '20_Sources/manual.md', edited);
    const current = await (await core.request('/v1/documents?path=20_Sources/manual.md')).json();
    expect(current).toMatchObject({ revision: sha256(Buffer.from(edited)), indexed_revision: sha256(Buffer.from(initial)), index_stale: true, processing_status: 'pending' });
    expect(await (await core.request('/v1/search?scope=sources&q=EditedSourceOnlyP1&fields=body')).json()).toMatchObject({ total: 0 });
    expect((await (await core.request('/v1/status')).json()).index_generation).toBe(initialStatus.index_generation);
    expect((await (await core.request('/v1/jobs')).json()).total).toBe(initialJobs.total);
    const next = await submitScan(core.request);
    const job = await finishedJob(core.request, next.job.id);
    expect(job).toMatchObject({ kind: 'scan_vault', status: 'succeeded', summary: { updated: 1, unchanged: 1, index_generation: 2 } });
    expect(await (await core.request('/v1/search?scope=sources&q=EditedSourceOnlyP1&fields=body')).json()).toMatchObject({ total: 1 });
    const jobs = await (await core.request('/v1/jobs')).json();
    expect(jobs.total).toBe(initialJobs.total + 1);
    expect(jobs.items.every((item: { kind: string }) => item.kind === 'scan_vault')).toBe(true);
    const after = await assetHashes(isolated.config.vault_path);
    expect(after).toEqual({ ...before, '20_Sources/manual.md': sha256(Buffer.from(edited)) });
    expect(await readFile(path.join(isolated.config.vault_path, '20_Sources/manual.md'), 'utf8')).toBe(edited);
    if (process.env.P1_EVIDENCE === '1') {
      await mkdir('.local/p1/evidence', { recursive: true });
      await writeFile('.local/p1/evidence/t14-knowledge-edit.json', `${JSON.stringify({ run_at: new Date().toISOString(), runtime: 'built standalone Core, real loopback HTTP and SQLite', initial_generation: initialStatus.index_generation, generation_after_explicit_scan: job.summary?.index_generation, jobs_before_edit: initialJobs.total, jobs_after_explicit_scan: jobs.total, current_before_scan: { revision: current.revision, indexed_revision: current.indexed_revision, index_stale: current.index_stale }, before_asset_hashes: before, after_asset_hashes: after, only_intentional_test_edit_changed: true }, null, 2)}\n`);
    }
  } finally { await core.close(); await isolated.cleanup(); }
});
