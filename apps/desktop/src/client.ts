import { invoke, isTauri } from '@tauri-apps/api/core';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import {
  API,
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
  scan: (mode: 'refresh' | 'rebuild') =>
    request('scan', API.scans.schema.response[202], { mode }),
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
