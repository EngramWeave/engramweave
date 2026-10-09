import { setTimeout as delay } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { ExecutionAttempt } from '@engramweave/contracts';
import { CoreError } from '../errors.js';

export class TransientExecutionError extends CoreError {
  constructor(message: string, readonly retryAfterMs = 0) { super('EXECUTION_FAILED', message); }
}
export const attemptError = (error: unknown) => error instanceof CoreError
  ? { code: error.code, message: error.message, details: null }
  : { code: 'EXECUTION_FAILED' as const, message: 'Execution failed; inspect the task and preserved files', details: null };
export function executionAttempts(db: Database.Database, id: string, task: string): ExecutionAttempt[] {
  return (db.prepare('SELECT attempt_json FROM execution_attempts WHERE job_id=? AND task=? ORDER BY number').all(id, task) as { attempt_json: string }[]).map(row => JSON.parse(row.attempt_json));
}
export interface RetryOptions { maxRetries?: number; signal?: AbortSignal; onAttempt?: (attempts: ExecutionAttempt[]) => Promise<void> }
/** Retries surround inference only, never file publication or unknown persistence outcomes. */
export async function inferWithRetries<T>(db: Database.Database, id: string, task: string, infer: () => Promise<T>, options: RetryOptions = {}) {
  const maxRetries = options.maxRetries ?? 0;
  for (let number = 1; ; number++) {
    options.signal?.throwIfAborted();
    const attempt: ExecutionAttempt = { number, status: 'running', started_at: new Date().toISOString(), finished_at: null, error: null, next_retry_at: null };
    const save = async () => {
      db.prepare('INSERT INTO execution_attempts VALUES(?,?,?,?) ON CONFLICT(job_id,task,number) DO UPDATE SET attempt_json=excluded.attempt_json').run(id, task, number, JSON.stringify(attempt));
      await options.onAttempt?.(executionAttempts(db, id, task));
    };
    await save();
    try { const result = await infer(); attempt.status = 'succeeded'; attempt.finished_at = new Date().toISOString(); await save(); return result; }
    catch (error) {
      attempt.status = options.signal?.aborted ? 'interrupted' : 'failed'; attempt.finished_at = new Date().toISOString(); attempt.error = attemptError(error);
      const retry = error instanceof TransientExecutionError && !options.signal?.aborted && number <= maxRetries;
      const wait = retry ? Math.min(30_000, Math.max(1000 * 2 ** (number - 1), error.retryAfterMs)) : 0;
      if (retry) attempt.next_retry_at = new Date(Date.now() + wait).toISOString();
      await save();
      if (!retry) throw error;
      await delay(wait, undefined, { signal: options.signal });
    }
  }
}
export function transientNetwork(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return signal.reason?.name === 'TimeoutError';
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
  return ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code ?? '');
}
