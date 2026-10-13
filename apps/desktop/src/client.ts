import { invoke, isTauri } from '@tauri-apps/api/core';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import {
  API,
  PLANNING_API,
  RESOURCE_API,
  type SearchQuery,
  type SourcesQuery,
  type CompilerSettings,
  type CompileRequest,
  type SourceBatchRequest,
} from '@engramweave/contracts';

export interface HostInfo {
  profile_path: string;
  node_path: string;
  core_entry: string;
  mode: 'owned' | 'attached' | 'disconnected';
}
export interface Failure {
  code: string;
  message: string;
  details?: unknown;
}
export const nativeAvailable = isTauri();
export function failure(error: unknown): Failure {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error
  )
    return error as Failure;
  return { code: 'IO_ERROR', message: String(error) };
}
function native<T>(
  command: string,
  input?: Record<string, unknown>,
): Promise<T> {
  if (!nativeAvailable)
    return Promise.reject({
      code: 'NATIVE_HOST_REQUIRED',
      message: '请在 Tauri Desktop 中运行；浏览器页面无法访问 Core。',
    });
  return invoke<T>(command, input);
}
async function request<T extends TSchema>(
  operation: string,
  schema: T,
  input: unknown = {},
): Promise<Static<T>> {
  const result = await native<unknown>('core_request', { operation, input });
  if (!Value.Check(schema, result))
    throw {
      code: 'INSTANCE_UNCERTAIN',
      message: 'Core 响应与共享契约不符，请重新连接。',
    };
  return result;
}
export const client = {
  reviewFiles: (input: import('@engramweave/contracts').ReviewBrowserQuery) => request('review_files', RESOURCE_API.review.schema.response[200], input),
  changeFiles: (input: import('@engramweave/contracts').ChangeBrowserQuery) => request('change_files', RESOURCE_API.changes.schema.response[200], input),
  changeOverview: (id: string) => request('change_overview', RESOURCE_API.overview.schema.response[200], { id }),
  candidate: (id: string, item_id: string) => request('candidate', PLANNING_API.candidate.schema.response[200], { id, item_id }),
  cancelChangeSet: (id: string) => request('change_set_cancel', PLANNING_API.changesetCancel.schema.response[200], { id }),
  job: (id: string) => request('job', API.job.schema.response[200], { id }),
  plannerSettings: () => request('planner_settings', PLANNING_API.settings.schema.response[200]),
  savePlannerSettings: (settings: import('@engramweave/contracts').PlannerSettings) => request('planner_settings_write', PLANNING_API.settingsWrite.schema.response[200], {settings}),
  plannerTemplate: () => request('planner_template', PLANNING_API.template.schema.response[200]),
  savePlannerTemplate: (input: {content:string;revision:string}) => request('planner_template_write', PLANNING_API.templateWrite.schema.response[200], input),
  plan: (input: import('@engramweave/contracts').PlanRequest) => request('plan', PLANNING_API.plan.schema.response[202], input),
  cancelPlan: (id:string) => request('plan_cancel', PLANNING_API.planCancel.schema.response[200], {id}),
  changesets: (source_path?:string) => request('change_sets', PLANNING_API.changesets.schema.response[200], source_path ? {source_path} : {}),
  openChangeSet: (id:string) => native<void>('open_changeset',{id}),
  previewCandidate: (id: string, itemId: string) => native<void>('preview_candidate', { id, itemId }),
  openIntegration: (id:string,path:string) => native<void>('open_integration_document',{id,path}),
  processingSettings: () => request('processing_settings', API.processingSettings.schema.response[200]),
  saveProcessingSettings: (input: import('@engramweave/contracts').ProcessingSettings) => request('processing_settings_write', API.processingSettingsWrite.schema.response[200], input),
  processingState: () => request('processing_state', API.processingState.schema.response[200]),
  process: (input: import('@engramweave/contracts').ProcessingRequest) => request('processing', API.processing.schema.response[202], input),
  processingRounds: (offset = 0) => request('processing_rounds', API.processingRounds.schema.response[200], { limit: 20, offset }),
  processingRound: (id: string) => request('processing_round', API.processingRound.schema.response[200], { id }),
  cancelProcessing: (id: string) => request('processing_cancel', API.processingCancel.schema.response[200], { id }),
  recompile: (input: import('@engramweave/contracts').RecompileRequest) => request('recompile', API.recompile.schema.response[200], input),
  draftReview: (path: string) => request('draft_review', API.draftReview.schema.response[200], { path }),
  analysisResult: (id: string) => request('analysis_result', API.analysisResult.schema.response[200], { id }),
  analysisSettings: () => request('analysis_settings', API.analysisSettings.schema.response[200]),
  saveAnalysisSettings: (input: Static<typeof API.analysisSettingsWrite.schema.body>) => request('analysis_settings_write', API.analysisSettingsWrite.schema.response[200], input),
  analysisTemplates: () => request('analysis_templates', API.analysisTemplates.schema.response[200]),
  saveAnalysisTemplate: (input: Static<typeof API.analysisTemplateWrite.schema.body>) => request('analysis_template_write', API.analysisTemplateWrite.schema.response[200], input),
  analysisSelection: (input: Static<typeof API.analysisSelection.schema.body>) => request('analysis_selection', API.analysisSelection.schema.response[200], input),
  analyze: (input: import('@engramweave/contracts').AnalyzeRequest) => request('analyze', API.analyze.schema.response[202], input),
  cancelAnalysis: (id: string) => request('analysis_cancel', API.analysisCancel.schema.response[200], { id }),
  info: () => native<HostInfo>('host_info'),
  connect: (start: boolean) =>
    native<{
      host: HostInfo;
      status: Static<(typeof API.status.schema.response)[200]>;
    }>(start ? 'core_start' : 'core_connect'),
  stop: () => native<HostInfo>('core_stop'),
  status: () => request('status', API.status.schema.response[200]),
  sources: (input: SourcesQuery) =>
    request('sources', API.sources.schema.response[200], input),
  jobs: () => request('jobs', API.jobs.schema.response[200], { limit: 20 }),
  document: (path: string) =>
    request('document', API.documents.schema.response[200], { path }),
  search: (input: SearchQuery) =>
    request('search', API.search.schema.response[200], input),
  scan: (mode: 'refresh' | 'rebuild', force_full = false) =>
    request('scan', API.scans.schema.response[202], { mode, ...(force_full ? { force_full } : {}) }),
  open: (path: string, target: 'obsidian' | 'original') =>
    native<void>('open_document', { path, target }),
  compilerSettings: () => request('compiler_settings', API.compilerSettings.schema.response[200]),
  saveCompilerSettings: (settings: CompilerSettings, api_key?: string) => request('compiler_settings_write', API.compilerSettingsWrite.schema.response[200], { settings, ...(api_key ? { api_key } : {}) }),
  compile: (input: CompileRequest) => request('compile', API.compile.schema.response[202], input),
  drafts: (source_path: string) => request('drafts', API.drafts.schema.response[200], { source_path }),
  draft: (path: string) => request('draft', API.draft.schema.response[200], { path }),
  sourceBatch: (input: SourceBatchRequest) => request('source_batch', API.sourceBatch.schema.response[202], input),
  sourceBatchStatus: (id: string) => request('source_batch_status', API.sourceBatchStatus.schema.response[200], { id }),
  discardPreview: (path: string) => request('discard_preview', API.discardPreview.schema.response[200], { path }),
  recallSettings: () => request('recall_settings', API.recallSettings.schema.response[200]),
  saveRecallSettings: (settings: import('@engramweave/contracts').RecallSettings, api_key?: string, reranker_key?: string) => request('recall_settings_write', API.recallSettingsWrite.schema.response[200], { settings, ...(api_key ? { api_key } : {}), ...(reranker_key ? { reranker_key } : {}) }),
  recallTest: () => request('recall_test', API.recallTest.schema.response[200]),
  recallStatus: () => request('recall_status', API.recallStatus.schema.response[200]),
  recallIndex: (mode: 'build' | 'update' | 'rebuild') => request('recall_index', API.recallIndex.schema.response[202], { mode }),
  recall: (input: import('@engramweave/contracts').RecallQuery) => request('recall', API.recall.schema.response[200], input),
  recallContext: (items: { path: string; revision: string; chunk_id: string }[]) => request('recall_context', API.recallContext.schema.response[200], { items }),
};
export type SourcePage = Awaited<ReturnType<typeof client.sources>>;
export type JobPage = Awaited<ReturnType<typeof client.jobs>>;
export type SearchPage = Awaited<ReturnType<typeof client.search>>;
