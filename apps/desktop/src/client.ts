import { invoke, isTauri } from '@tauri-apps/api/core';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import {
  API,
  type SearchQuery,
  type SourcesQuery,
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
};
export type SourcePage = Awaited<ReturnType<typeof client.sources>>;
export type JobPage = Awaited<ReturnType<typeof client.jobs>>;
export type SearchPage = Awaited<ReturnType<typeof client.search>>;
