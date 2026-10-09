import { parentPort, workerData } from 'node:worker_threads';
import { RecallStorage } from './storage.js';
let storage: RecallStorage;
try { storage = new RecallStorage(workerData.directory, workerData.vault); parentPort!.postMessage({ ready: true }); }
catch { parentPort!.postMessage({ ready: false, error: 'Semantic cache is unsafe or unavailable; preserve it and rebuild explicitly.' }); }
parentPort!.on('message', ({ id, method, args }: { id: number; method: string; args: unknown[] }) => {
  try {
    if (!storage || !['info', 'meta', 'reset', 'prepare', 'cache', 'remove', 'publish', 'retrieve', 'context', 'verifyEvidence', 'close'].includes(method)) throw new Error('Unsupported semantic storage operation');
    const callable = storage[method as keyof RecallStorage] as (...args: unknown[]) => unknown;
    parentPort!.postMessage({ id, value: callable.apply(storage, args) });
  } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Semantic storage operation failed' }); }
});
