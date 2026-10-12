import type { Config, PlannerSettings } from '@engramweave/contracts';
import type { HumanReviewActions } from '../review/human.js';
import type { AnalyzerJobs } from '../jobs/analyzer.js';
import { readMarkdown } from '../files/read.js';
import { readDraft } from '../drafts/files.js';
import { markdownPath } from '../files/paths.js';
import { parseMarkdown } from '../source/parse.js';
import { CoreError } from '../errors.js';
import type { PlannerSettingsStore } from './settings.js';

export interface PlanningSnapshot {
  source: { path: string; revision: string; content: string };
  draft: { path: string; revision: string; content: string };
  intent: string; settings: PlannerSettings;
  template: Awaited<ReturnType<PlannerSettingsStore['template']>>;
  relation: { job_id: string; stale: boolean; reasons: string[]; result: unknown } | null;
}
export async function planningInput(config: Config, sourcePath: string, human: HumanReviewActions, settings: PlannerSettingsStore, analyzer?: Pick<AnalyzerJobs, 'latestForDraft' | 'result'>): Promise<PlanningSnapshot> {
  markdownPath(sourcePath);
  const source = await readMarkdown(config.vault_path, sourcePath); const parsed = parseMarkdown(sourcePath, source.bytes);
  if (parsed.kind !== 'source' || parsed.state !== 'ready' || parsed.lifecycle_status !== 'active' || parsed.processing_status !== 'reviewed') throw new CoreError('INVALID_SOURCE', 'Planner requires an active, ready, reviewed Source', 422);
  const selected = await human.selection(sourcePath);
  if (!selected) throw new CoreError('INVALID_SOURCE', 'Select a Reviewed Draft through Review Complete before planning', 422);
  const draft = await readDraft(config.vault_path, selected); const draftFile = await readMarkdown(config.vault_path, selected);
  if (draftFile.revision !== draft.revision) throw new CoreError('SOURCE_CHANGED', 'Draft changed while fixing planning input', 409);
  const context = await human.context(sourcePath, selected); const execution = settings.read();
  if (!execution.enabled || !execution.codex_path) throw new CoreError('CONFIG_ERROR', 'Configure and enable the Agent Planner in Desktop first', 400);
  const latest = analyzer?.latestForDraft(selected, 'relation'); let relation: PlanningSnapshot['relation'] = null;
  if (latest && analyzer) {
    try{const result = await analyzer.result(latest.id); if (result.relation) relation = { job_id: latest.id, stale: result.stale, reasons: result.stale_reasons, result: result.relation };}
    catch{relation={job_id:latest.id,stale:true,reasons:['Optional Relation result is unavailable; verify relationships from current notes.'],result:null};}
  }
  return { source: { path: sourcePath, revision: source.revision, content: new TextDecoder('utf-8', { fatal: true }).decode(source.bytes) },
    draft: { path: selected, revision: draftFile.revision, content: new TextDecoder('utf-8', { fatal: true }).decode(draftFile.bytes) }, intent: context.intent ?? '', settings: execution, template: await settings.template(), relation };
}
