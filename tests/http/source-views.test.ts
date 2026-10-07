import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { httpRuntime, submitScan, finishedJob } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';

it('queries overlapping Source views with AND dimensions, OR categories, Registry tags and captured sorting', async () => {
  const runtime = await httpRuntime(async vault => {
    for (const [name, stage, tags] of [['a', 'pending', 'LLM'], ['b', 'compiled', 'LLM'], ['c', 'reviewed', 'Stats'], ['d', 'archived', 'Stats'], ['missing', 'pending', 'LLM']]) {
      await writeDocument(vault, `20_Sources/${name}.md`, manualSource(name!, `processing_status: ${stage}\ntags: [${tags}]\n`));
    }
    await writeDocument(vault, '20_Sources/discarded.md', manualSource('discarded', 'processing_status: pending\nlifecycle_status: discarded\n'));
    await writeDocument(vault, '20_Sources/invalid.md', manualSource('invalid', 'processing_status: typo\n'));
  });
  try {
    const scan = await submitScan(runtime.request); expect((await finishedJob(runtime.request, scan.job.id)).status).toBe('succeeded');
    await unlink(path.join(runtime.config.vault_path, '20_Sources/missing.md'));
    const next = await submitScan(runtime.request); expect((await finishedJob(runtime.request, next.job.id)).status).toBe('succeeded');
    const all = await (await runtime.request('/v1/sources?view=all')).json();
    expect(all.total).toBe(7); expect(all.views).toEqual({ all: 7, pending: 3, processing: 2, archived: 1, issues: 2, discarded: 1 });
    expect(all.facets.tags).toEqual(['LLM', 'Stats']);
    const pending = await (await runtime.request('/v1/sources?view=pending')).json();
    expect(pending.items.some((item: any) => item.state === 'missing' && item.processing_status === 'pending' && item.lifecycle_status === 'active')).toBe(true);
    const query = new URLSearchParams({ view: 'all', types: JSON.stringify(['manual', 'web']), tags: JSON.stringify(['LLM']), sort: 'title_desc' });
    const filtered = await (await runtime.request(`/v1/sources?${query}`)).json();
    expect(filtered.items.map((item: any) => item.path)).toEqual(['20_Sources/missing.md', '20_Sources/b.md', '20_Sources/a.md']);
    const issues = await (await runtime.request('/v1/sources?view=issues&issues=' + encodeURIComponent(JSON.stringify(['missing'])))).json();
    expect(issues.total).toBe(1);
    expect((await (await runtime.request('/v1/status')).json()).counts.pending).toBe(3);
    expect((await runtime.request('/v1/sources?view=all&tags=invalid-json')).status).toBe(400);
  } finally { await runtime.cleanup(); }
});
