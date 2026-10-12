import { randomUUID } from 'node:crypto';
import type { ChangeSetApproval } from '@engramweave/contracts';
import { humanFixture } from './human-review.js';
import { PlannerJobs, type PlannerExecutor } from '../../packages/core/src/jobs/planner.js';
import { defaultPlannerSettings } from '../../packages/core/src/planning/settings.js';
import { IntegrationExecutor } from '../../packages/core/src/changesets/executor.js';

export async function integrationFixture(plan?: PlannerExecutor) {
  const f = await humanFixture(false); await f.human.submit(await f.request('complete', 'Keep my reviewed understanding.'));
  const planner = new PlannerJobs(f.db, f.config, f.recall, f.human, () => false, undefined, plan ?? (async (snapshot, tools) => {
    await tools.call('write_file', { target: '40_Knowledge/Integrated.md', content: `---\nsources: ["[[${snapshot.source.path}]]"]\n---\nReviewed knowledge.\n`, reason: 'Integrate reviewed content' });
    return { changeset_id: tools.changesetId, summary: 'Ready' };
  }));
  await planner.initialize(); await planner.settings.save({ ...defaultPlannerSettings, enabled: true, codex_path: process.execPath });
  const submitted = await planner.submit({ request_id: randomUUID(), source_path: f.sourcePath }); await planner.wait();
  const job = planner.get(submitted.job.id)!; if (job.status !== 'succeeded') throw new Error(JSON.stringify(job.error));
  const execution = new IntegrationExecutor(f.config, f.db, planner.changesets, f.human, () => false, (source, id) => f.human.revoke(source, null, id));
  planner.protectExecutions(id => execution.owns(id)); await execution.initialize();
  const id = job.changeset_id!;
  const choose = async (included?: string[], domains = true) => {
    const review = await execution.reviews.read(id);
    return execution.reviews.save({ ...review, decisions: review.decisions.map(item => ({ ...item, decision: !included || included.includes(item.item_id) ? 'include' : 'reject', domain_approved: domains })) });
  };
  const approval = async (): Promise<ChangeSetApproval> => {
    const inspection = await execution.reviews.inspect(id);
    return { request_id: randomUUID(), changeset_id: id, manifest_revision: inspection.manifest_revision, review_revision: inspection.review.revision,
      source_revision: inspection.source_revision, draft_path: f.draftPath, related_drafts: inspection.related_drafts,
      items: inspection.targets.filter(item => inspection.review.decisions.some(decision => decision.item_id === item.item_id && decision.decision === 'include'))
        .map(({ item_id, candidate_revision, current_revision }) => ({ item_id, candidate_revision, current_revision })) };
  };
  return { ...f, planner, execution, id, choose, approval, async close() { await execution.close(); await planner.close(); await f.close(); } };
}
