import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../packages/core/dist/storage/database.js';
import { HumanReviewActions } from '../../packages/core/dist/review/human.js';
import { PlannerJobs } from '../../packages/core/dist/jobs/planner.js';
import { readMarkdown } from '../../packages/core/dist/files/read.js';
import { defaultPlannerSettings } from '../../packages/core/dist/planning/settings.js';

/** Task-owned native UI fixture. Proposal generation is simulated, file operations are real. */
export async function resourceVault(root, port) {
  const allowed = path.resolve('.local/P3/ui'); const absolute = path.resolve(root);
  if (!absolute.startsWith(`${allowed}${path.sep}`)) throw new Error('Native UI fixture must stay in its task-owned directory');
  const config = { config_version: 1, vault_path: path.join(absolute, `ew-resource-${Date.now()}`), data_dir: path.join(absolute, 'data'), host: '127.0.0.1', port };
  for (const directory of ['10_Ideas', '20_Sources', '30_Drafts', '40_Knowledge', '50_Research', '60_Projects']) await mkdir(path.join(config.vault_path, directory), { recursive: true });
  const draftBytes = (source, title, lifecycle = 'active') => `---\ntype: draft\ntitle: ${JSON.stringify(title)}\nlifecycle_status: ${lifecycle}\nsources: ["[[20_Sources/${source}.md]]"]\n---\n# ${title}\n\nUser-reviewed wording. Applies only under condition A.\n`;
  for (const name of ['alpha', 'beta', 'gamma']) {
    await writeFile(path.join(config.vault_path, `20_Sources/${name}.md`), `---\ntype: raw_source\nsource_type: manual\ntitle: ${name} selected material\nlifecycle_status: active\nprocessing_status: compiled\ncaptured_at: 2026-10-12\nannotation: Personal interpretation\n---\nSelected material under condition A.\n`);
    await writeFile(path.join(config.vault_path, `30_Drafts/${name}.md`), draftBytes(name, `${name} reviewed understanding`));
  }
  await writeFile(path.join(config.vault_path, '30_Drafts/gamma-other.md'), draftBytes('gamma', 'gamma alternative understanding'));
  for (let index = 0; index < 22; index++) await writeFile(path.join(config.vault_path, `30_Drafts/alpha-${index}.md`), draftBytes('alpha', `alpha retained draft ${String(index).padStart(2, '0')}`));
  await writeFile(path.join(config.vault_path, '30_Drafts/discarded.md'), draftBytes('alpha', 'Archived old draft', 'discarded'));
  await writeFile(path.join(config.vault_path, '30_Drafts/broken.md'), 'Invalid Draft Properties retained for repair.');
  await mkdir(config.data_dir, { recursive: true });
  const db = await openDatabase(config); const human = new HumanReviewActions(config, db, () => false); await human.initialize();
  const planner = new PlannerJobs(db, config, { recall: async () => { throw new Error('No model recall in this fixture'); }, context: async () => { throw new Error('No model context in this fixture'); } }, human, () => false, undefined,
    async (snapshot, tools) => {
      const title = path.posix.basename(snapshot.source.path, '.md');
      await tools.call('write_file', { target: `40_Knowledge/${title}.md`, content: `---\ntitle: ${title}\nsources: ["[[${snapshot.source.path}]]"]\n---\n# ${title}\n\nReviewed understanding with condition A.\n`, reason: 'Preserve reviewed meaning.' });
      return { changeset_id: tools.changesetId, summary: 'Simulated proposal for native UI validation.' };
    });
  const proposals = [];
  try {
    await planner.initialize(); await planner.settings.save({ ...defaultPlannerSettings, enabled: true, codex_path: process.execPath, model: 'simulated-ui-planner' });
    for (const name of ['alpha', 'beta']) {
      const source = `20_Sources/${name}.md`; const draft = `30_Drafts/${name}.md`;
      await human.submit({ request_id: randomUUID(), action: 'complete', source_path: source, source_revision: (await readMarkdown(config.vault_path, source)).revision, draft_path: draft, draft_revision: (await readMarkdown(config.vault_path, draft)).revision, note: 'Preserve my reviewed phrasing.' });
      const result = await planner.submit({ request_id: randomUUID(), source_path: source }); await planner.wait();
      const job = planner.get(result.job.id); if (job.status !== 'succeeded') throw new Error(JSON.stringify(job.error)); proposals.push(job.changeset_id);
    }
  } finally { await planner.close(); await human.close(); db.close(); }
  const broken = randomUUID(); await mkdir(path.join(config.vault_path, `70_ChangeSets/${broken}`)); await writeFile(path.join(config.vault_path, `70_ChangeSets/${broken}/manifest.json`), 'Broken workspace manifest.');
  return { config, proposals, broken, draftBytes };
}
