import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { FileProblem } from './read.js';
import { windowsFilesExecutable } from './native-path.js';

/** One lazily started native process per scan, not one compiler invocation per Source. */
export class PropertyNative {
  constructor(private readonly onRead?: (count: number) => void) {}
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: { resolve: (result: { mtime: number }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  private start() {
    const child = this.child = spawn(windowsFilesExecutable, ['commit'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', () => { if (this.child === child) this.fail(); });
    child.on('error', () => { if (this.child === child) this.fail(); });
    child.on('close', () => { if (this.child === child) { this.fail(); this.child = undefined; } });
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child) return;
      const pending = this.pending;
      if (!pending) return;
      this.pending = undefined; clearTimeout(pending.timer);
      try {
        const result: unknown = JSON.parse(line);
        if (!result || typeof result !== 'object' || !('read_bytes' in result) || !Number.isSafeInteger(result.read_bytes) || Number(result.read_bytes) < 0 || Number(result.read_bytes) > 20 * 1024 * 1024) throw new Error('Invalid native response');
        this.onRead?.(Number(result.read_bytes));
        if ('ok' in result && result.ok === true && 'mtime' in result && typeof result.mtime === 'number' && Number.isFinite(result.mtime) && result.mtime >= 0) pending.resolve({ mtime: result.mtime });
        else pending.reject(new FileProblem('PROPERTY_WRITE_CONFLICT', 'invalid', 'Property commit refused; original and uncertain artifacts were preserved'));
      } catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid native response')); }
    });
  }
  private fail() {
    if (!this.pending) return;
    const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
    pending.reject(new FileProblem('PROPERTY_WRITE_INTERRUPTED', 'invalid', 'Native property commit was interrupted; inspect preserved artifacts'));
  }
  async run(vault: string, relative: string, stem: string, before: string, after: string, manifest: string, recover = false, payload?: { manifest_bytes: string; replacement_bytes: string }, remove = false) {
    if (this.pending) throw new Error('Property commits must be sequential');
    if (!this.child) this.start();
    return new Promise<{ mtime: number }>((resolve, reject) => {
      const timer = setTimeout(() => { this.child?.kill(); this.fail(); }, 30_000);
      this.pending = { resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify({ vault, relative, stem, before, after, manifest, recover, delete: remove, ...payload }) + '\n');
    });
  }
  async remove(vault: string, relative: string, revision: string) {
    if (!/^20_Sources\/.+\.md$/i.test(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\:\x00-\x1f]/.test(segment))) throw new Error('Deletion requires an explicit Source Record path');
    await this.run(vault, relative, '', revision, '', '', false, undefined, true);
  }
  async close() {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end();
    await closed;
  }
}
