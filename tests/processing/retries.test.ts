import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { inferWithRetries, executionAttempts, TransientExecutionError, transientNetwork } from '../../packages/core/src/processing/retries.js';
import { executeApiText } from '../../packages/core/src/execution/api.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';

afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
describe('bounded inference retries', () => {
  it('records the initial call and bounded retries, then stops on an unclassified permanent failure', async () => {
    const f = await analyzerFixture(async task => emptyAnalysis(task));
    try {
      const id = randomUUID(); let calls = 0;
      const pending = inferWithRetries(f.db, id, 'compiler', async () => { calls++; if (calls === 1) throw new TransientExecutionError('temporary', 0); throw new CoreError('INVALID_MODEL_OUTPUT', 'bad output'); }, { maxRetries: 2 });
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' }); expect(calls).toBe(2);
      expect(executionAttempts(f.db, id, 'compiler').map(a => a.error?.code)).toEqual(['EXECUTION_FAILED','INVALID_MODEL_OUTPUT']);
    } finally { await f.close(); }
  });
  it('stops cancellable retry waits without a second call', async () => {
    const f = await analyzerFixture();
    try {
      const controller = new AbortController(); const id = randomUUID(); let calls = 0;
      const pending = inferWithRetries(f.db, id, 'review', async () => { calls++; throw new TransientExecutionError('temporary', 30000); }, { maxRetries: 5, signal: controller.signal, onAttempt: async attempts => { if (attempts.at(-1)?.next_retry_at) controller.abort(); } });
      await expect(pending).rejects.toThrow(); expect(calls).toBe(1);
    } finally { await f.close(); }
  });
  it('exhausts its finite budget and records each failure instead of silently looping', async () => {
    const f = await analyzerFixture();
    try {let calls=0;const id=randomUUID();await expect(inferWithRetries(f.db,id,'review',async()=>{calls++;throw new TransientExecutionError('temporary');},{maxRetries:2})).rejects.toBeInstanceOf(TransientExecutionError);expect(calls).toBe(3);expect(executionAttempts(f.db,id,'review')).toHaveLength(3);expect(executionAttempts(f.db,id,'review').at(-1)?.next_retry_at).toBeNull();}
    finally {await f.close();}
  });
  it('bounds Retry-After and classifies timeout separately from cancellation or unknown failure', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429,headers:{'retry-after':'100000'}})));
    await expect(executeApiText({...defaultSettings,endpoint:'http://127.0.0.1:8094/v1'},'','{}',new AbortController().signal,'instructions',{},'fixture')).rejects.toMatchObject({retryAfterMs:30000});
    expect(transientNetwork(new Error('temporary words'),new AbortController().signal)).toBe(false);
    expect(transientNetwork(new Error('timeout'),AbortSignal.abort(new DOMException('Timeout','TimeoutError')))).toBe(true);
    expect(transientNetwork(new Error('cancelled'),AbortSignal.abort())).toBe(false);
  });
});
