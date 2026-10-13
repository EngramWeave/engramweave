import type { Config, ChangeFile, ChangeBrowserQuery } from '@engramweave/contracts';
import { CHANGE_VIEWS } from '@engramweave/contracts';
import type { CoreServices } from '../http/context.js';
import { CoreError } from '../errors.js';
import { readDraft } from '../drafts/files.js';

export async function changeFiles(config: Config, services: CoreServices, query: ChangeBrowserQuery) {
  const planner = services.planner;
  if (!planner) throw new CoreError('CORE_UNAVAILABLE', 'Planner is unavailable', 503);
  const plans = planner.all(); const executions = services.integration?.all() ?? [];
  const rows: { item: ChangeFile; targets: string[]; kinds: string[] }[] = [];
  for (const id of await planner.changesets.workspaces()) {
    const job = plans.find(job => job.changeset_id === id);
    const execution = executions.find(job => job.changeset_id === id);
    const owned = Boolean(services.integration?.owns(id) || services.integration?.accepting(id));
    const item: ChangeFile = { id, path: `70_ChangeSets/${id}`, title: id.slice(0, 8), source_path: job?.source_path ?? execution?.source_path ?? null, draft_path: job?.draft_path ?? null,
      created_at: job?.created_at ?? execution?.created_at ?? null, state: owned ? 'executing' : 'issues', impact: { write: 0, directory: 0, discard: 0 }, planner_job: job?.id ?? null,
      execution_id: execution?.id ?? null, execution_status: execution?.status ?? null, can_cancel: false, diagnostics: [] };
    const row = { item, targets: [] as string[], kinds: [] as string[] };
    try {
      const { manifest } = await planner.changesets.read(id);
      item.source_path = manifest.source_path; item.draft_path = manifest.draft_path; item.created_at = manifest.created_at;
      item.state = owned ? 'executing' : manifest.state;
      for (const entry of manifest.items) { if (entry.kind === 'write' || entry.kind === 'directory' || entry.kind === 'discard') item.impact[entry.kind]++; row.targets.push(entry.target); row.kinds.push(entry.kind); }
      try { item.title = (await readDraft(config.vault_path, manifest.draft_path)).title; }
      catch { item.diagnostics.push({ code: 'DRAFT_UNREADABLE', message: 'The original Draft is missing or unreadable.' }); }
      if (manifest.state === 'ready') await planner.changesets.verifyCandidates(id);
      if (!owned && !job) item.diagnostics.push({ code: 'PLANNING_RECEIPT_MISSING', message: 'The planning receipt cannot be verified.' });
      if (job?.error) item.diagnostics.push({ code: job.error.code, message: job.error.message });
      if (execution?.error) item.diagnostics.push({ code: execution.error.code, message: execution.error.message });
      item.can_cancel = !owned && Boolean(job) && manifest.state === 'ready' && !planner.busy();
      if (!owned && item.diagnostics.length) item.state = 'issues';
    } catch (error) { item.diagnostics.push({ code: error instanceof CoreError ? error.code : 'WORKSPACE_UNREADABLE', message: 'The workspace is missing files or cannot be read safely.' }); }
    rows.push(row);
  }
  const matches = (item: ChangeFile, view: string) => view === 'all' || view === 'issues' ? view === 'all' || item.diagnostics.length > 0 || item.state === 'issues' : item.state === view;
  const views = Object.fromEntries(CHANGE_VIEWS.map(view => [view, rows.filter(row => matches(row.item, view)).length]));
  const q = query.q?.trim().toLowerCase() ?? '';
  const filtered = rows.filter(({ item, targets, kinds }) => matches(item, query.view ?? 'all') && (!q || [item.title, item.id, item.source_path, item.draft_path, ...targets].join('\n').toLowerCase().includes(q))
    && (!query.source_path || item.source_path?.toLowerCase() === query.source_path.toLowerCase()) && (!query.kind || kinds.includes(query.kind)) && (!query.domain || targets.some(target => target.startsWith(`${query.domain}/`))));
  filtered.sort(({ item: a }, { item: b }) => (query.sort === 'title_asc' ? a.title.localeCompare(b.title) : query.sort === 'created_asc' ? (a.created_at ?? '').localeCompare(b.created_at ?? '') : (b.created_at ?? '').localeCompare(a.created_at ?? '')) || a.id.localeCompare(b.id));
  const offset = query.offset ?? 0;
  return { items: filtered.slice(offset, offset + (query.limit ?? 20)).map(row => row.item), total: filtered.length, views };
}
