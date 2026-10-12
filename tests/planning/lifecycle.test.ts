import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { humanFixture } from '../helpers/human-review.js';
import { HumanReviewActions } from '../../packages/core/src/review/human.js';
import { PlannerJobs } from '../../packages/core/src/jobs/planner.js';
import { CompilerJobs } from '../../packages/core/src/jobs/compiler.js';
import { SourceBatches } from '../../packages/core/src/jobs/source-batches.js';
import { defaultPlannerSettings } from '../../packages/core/src/planning/settings.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';

async function waitBatch(batches: SourceBatches) {
  const deadline = Date.now() + 60_000;
  while (batches.busy()) {
    if (Date.now() > deadline) throw new Error('Lifecycle batch did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it('discards a planned Source and restores only the Source to pending, preserving Intent without reviving a plan', async () => {
  const f = await humanFixture(false);
  let calls = 0;
  let planner: PlannerJobs | undefined;
  const human = new HumanReviewActions(f.config, f.db, () => false, async () => false, source => planner!.cancelForSource(source));
  const compiler = new CompilerJobs(f.db, f.config, () => false, async () => { calls++; return { title: 'Unexpected', body: 'No automatic compilation.' }; });
  const batches = new SourceBatches(f.config, f.db, compiler, () => false, undefined, async target => {
    if (target.startsWith('20_Sources/')) { await human.revoke(target); await planner!.cancelForSource(target); }
    else if (target === f.draftPath) { await human.revoke(f.sourcePath, target); await planner!.cancelForSource(f.sourcePath); }
  });
  try {
    await compiler.initialize(); await human.initialize();
    await human.submit(await f.request('complete', 'Keep my integration intention'));
    planner = new PlannerJobs(f.db, f.config, f.recall, human, () => false, undefined, async (snapshot, tools) => {
      calls++;
      await tools.call('write_file', { target: '40_Knowledge/new.md', content: `---\nsources: ["[[${snapshot.source.path}]]"]\n---\nThe reviewed understanding.\n`, reason: 'Preserve reviewed content' });
      return { changeset_id: tools.changesetId, summary: 'A candidate integration.' };
    });
    await planner.initialize(); await planner.settings.save({ ...defaultPlannerSettings, enabled: true, codex_path: process.execPath });
    const job = await planner.submit({ request_id: randomUUID(), source_path: f.sourcePath }); await planner.wait();
    expect(planner.get(job.job.id)?.status).toBe('succeeded');
    const formal = await readFile(path.join(f.config.vault_path, f.libraryPath), 'utf8');
    const before = (await readMarkdown(f.config.vault_path, f.sourcePath)).bytes.toString();
    expect(before).toContain('processing_status: planned');
    const preview = await batches.preview(f.sourcePath);
    const discard = { id: randomUUID(), action: 'discard' as const, items: [{ ...preview.source, request_id: randomUUID(), related: preview.drafts }] };
    await batches.submit(discard); await waitBatch(batches);
    expect(batches.get(discard.id).items[0]?.status).toBe('succeeded');
    expect(await planner.changesets.list()).toEqual([]);
    const restoreBatches = new SourceBatches(f.config, f.db, compiler, () => false, undefined, async source => { await human.revoke(source); await planner!.cancelForSource(source); });
    try {
      const restore = { id: randomUUID(), action: 'restore' as const, items: [{ path: f.sourcePath, revision: (await readMarkdown(f.config.vault_path, f.sourcePath)).revision, request_id: randomUUID() }] };
      await restoreBatches.submit(restore); await waitBatch(restoreBatches);
      expect(restoreBatches.get(restore.id).items[0]?.status).toBe('succeeded');
    } finally { await restoreBatches.close(); }
    const restored = (await readMarkdown(f.config.vault_path, f.sourcePath)).bytes.toString();
    expect(restored).toContain('processing_status: pending'); expect(restored).toContain('lifecycle_status: active');
    expect(restored.split('---')[2]).toBe(before.split('---')[2]);
    expect(restored).toContain('annotation: "My understanding is broader than the original."');
    expect((await readDraft(f.config.vault_path, f.draftPath)).lifecycle_status).toBe('discarded');
    expect(await readFile(path.join(f.config.vault_path, f.libraryPath), 'utf8')).toBe(formal);
    await human.initialize(); await planner.initialize();
    expect(await human.context(f.sourcePath, f.draftPath)).toEqual({ selected_draft: null, intent: 'Keep my integration intention' });
    expect(await planner.changesets.list()).toEqual([]); expect(calls).toBe(1);
  } finally { await batches.close(); await compiler.close(); await planner?.close(); await human.close(); await f.human.close(); await f.close(); }
});
