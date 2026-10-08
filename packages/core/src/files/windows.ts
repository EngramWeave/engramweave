import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { windowsFilesExecutable } from './native-path.js';
import { CoreError } from '../errors.js';

interface Attributes { path: string; reparse: boolean; hidden: boolean }
type Request = { paths: string[]; resolve: (values: Attributes[]) => void; reject: (error: CoreError) => void; timer?: ReturnType<typeof setTimeout> };
let worker: AttributeWorker | undefined;
let leases = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const problem = () => new CoreError('IO_ERROR', 'Windows file attributes could not be inspected');
function clearIdle() { clearTimeout(idle); idle = undefined; }
function scheduleIdle(current: AttributeWorker) {
  if (leases || worker !== current) return;
  clearIdle();
  idle = setTimeout(() => { if (worker === current && !leases) { worker = undefined; void current.close(); } }, 1000);
}
class AttributeWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private queue: Request[] = [];
  private active: Request | undefined;
  private closing = false;
  constructor() {
    this.child = spawn(windowsFilesExecutable, ['attributes'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(); resolve(); }));
    this.child.stderr.resume();
    this.child.once('error', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
    createInterface({ input: this.child.stdout }).on('line', line => {
      const item = this.active; if (!item) return;
      this.active = undefined; clearTimeout(item.timer);
      try {
        const values: unknown = JSON.parse(line);
        if (!Array.isArray(values) || values.length !== item.paths.length || values.some((value, index) => !value || typeof value !== 'object' || value.path !== item.paths[index] || typeof value.reparse !== 'boolean' || typeof value.hidden !== 'boolean')) throw problem();
        item.resolve(values);
      } catch { item.reject(problem()); }
      this.next();
    });
  }
  request(paths: string[]) {
    clearIdle();
    return new Promise<Attributes[]>((resolve, reject) => { this.queue.push({ paths, resolve, reject }); this.next(); });
  }
  private next() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) { if (this.closing) this.child.stdin.end(); else scheduleIdle(this); return; }
    this.active = item;
    item.timer = setTimeout(() => { this.fail(); this.child.kill(); }, 15_000);
    this.child.stdin.write(JSON.stringify(item.paths) + '\n');
  }
  private fail() {
    clearTimeout(this.active?.timer);
    this.active?.reject(problem()); this.active = undefined;
    for (const item of this.queue.splice(0)) item.reject(problem());
    if (worker === this) { worker = undefined; clearIdle(); }
    this.child.kill();
  }
  async close() { this.closing = true; this.next(); await this.closed; }
}
/** Keep one checked IPC worker for a Core/batch lifetime; standalone readers release it when idle. */
export function retainWindowsAttributes() {
  leases++; clearIdle(); let released = false;
  return async () => {
    if (released) return; released = true;
    if (--leases === 0 && worker) { const current = worker; worker = undefined; clearIdle(); await current.close(); }
  };
}
export async function windowsAttributes(paths: string[]): Promise<Attributes[]> {
  if (!paths.length) return [];
  const results: Attributes[] = [];
  for (let offset = 0; offset < paths.length; offset += 512) {
    worker ??= new AttributeWorker();
    results.push(...await worker.request(paths.slice(offset, offset + 512)));
  }
  return results;
}
