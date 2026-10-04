import type { Config, Job } from '@engramweave/contracts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCore } from '../../packages/core/src/main.js';
import { isolatedRuntime } from './runtime.js';

export async function httpRuntime(prepare?: (vault: string) => Promise<void>) {
  const isolated = await isolatedRuntime();
  if (prepare) await prepare(isolated.config.vault_path);
  const connected = await httpCore(isolated.config);
  return { ...isolated, ...connected, async cleanup() { await connected.core.close(); await isolated.cleanup(); } };
}
export async function httpCore(config: Config) {
  const core = await startCore(config);
  const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
  const request = (route: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${config.port}${route}`, { ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers } });
  return { core, request };
}
export async function finishedJob(request: (route: string) => Promise<Response>, id: string): Promise<Job> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const response = await request(`/v1/jobs/${id}`);
    if (!response.ok) throw new Error('Job query failed');
    const job = await response.json() as Job;
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(25);
  }
  throw new Error('Scan did not finish before the test deadline');
}
export const submitScan = async (request: (route: string, init?: RequestInit) => Promise<Response>, mode = 'refresh') => {
  const response = await request('/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  return { status: response.status, ...await response.json() as { job: Job; reused: boolean } };
};
