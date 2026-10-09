import { Worker } from 'node:worker_threads';
import { CoreError } from '../errors.js';
import type { RecallStorage } from './storage.js';
export class RecallWorker {
  private worker: Worker;
  private id = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private ready: Promise<void>;
  private unavailable = false;
  constructor(directory: string, vault: string) {
    this.worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? '../../dist/recall/worker.js' : './worker.js', import.meta.url), { workerData: { directory, vault } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', message => {
        if ('ready' in message) { if (message.ready) resolve(); else { this.unavailable = true; reject(new CoreError('DATABASE_ERROR', message.error, 503)); } return; }
        const item = this.pending.get(message.id); if (!item) return; this.pending.delete(message.id);
        if (message.error) item.reject(new CoreError('DATABASE_ERROR', message.error, 503)); else item.resolve(message.value);
      });
      const fail = () => { this.unavailable = true; const error = new CoreError('DATABASE_ERROR', 'Semantic worker stopped; restart Core and retry explicitly', 503); reject(error); for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
      this.worker.on('error', fail); this.worker.on('exit', fail);
    });
    void this.ready.catch(() => {});
  }
  async call<K extends keyof RecallStorage>(method: K, ...args: Parameters<RecallStorage[K]>): Promise<ReturnType<RecallStorage[K]>> {
    await this.ready;
    if (this.unavailable) throw new CoreError('DATABASE_ERROR', 'Semantic worker is unavailable; rebuild explicitly', 503);
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve: value => resolve(value as ReturnType<RecallStorage[K]>), reject }); this.worker.postMessage({ id, method, args }); });
  }
  async close() { try { if (!this.unavailable) await this.call('close'); } catch { /* A failed semantic worker must not prevent standalone Core shutdown. */ } finally { await this.worker.terminate(); } }
}
