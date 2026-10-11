import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lstat } from 'node:fs/promises';
import { windowsFilesExecutable } from '../files/native-path.js';

export interface ChangeSnapshot { paths: string[]; reason: string | null }
/** Session-only hints: restart, uncertainty and periodic reconciliation require a full explicit scan. */
export class VaultChanges {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: { resolve: (value: unknown) => void; reject: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  private backlog = new Set<string>();
  private reason: string | null = 'core_started';
  private checkedAt = 0;
  private identity = '';
  constructor(private readonly vault: string) {}
  private async request(line: string): Promise<unknown> {
    const child = this.child;
    if (!child || this.pending) throw new Error('Watcher is unavailable');
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('Watcher is unavailable'));
      const timer = setTimeout(() => { this.pending = undefined; child.kill(); fail(); }, 5000);
      this.pending = { resolve, reject: fail, timer }; child.stdin.write(line + '\n');
    });
  }
  async start() {
    if (this.child) return;
    const info = await lstat(this.vault, { bigint: true }); this.identity = `${info.dev}:${info.ino}`;
    const child = this.child = spawn(windowsFilesExecutable, ['watch'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const fail = () => {
      if (this.child !== child) return;
      this.reason = 'watcher_unavailable'; this.child = undefined;
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(); this.pending = undefined; }
    };
    child.stderr.resume(); child.on('error', fail); child.on('close', fail); child.stdin.on('error', fail);
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child || !this.pending) return;
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
      try { pending.resolve(JSON.parse(line)); } catch { pending.reject(); }
    });
    const ready = await this.request(JSON.stringify({ vault: this.vault })) as { ready?: boolean };
    if (ready?.ready !== true) { await this.close(); throw new Error('Watcher could not start'); }
  }
  async capture(): Promise<ChangeSnapshot> {
    try {
      const info = await lstat(this.vault, { bigint: true });
      if (this.identity && this.identity !== `${info.dev}:${info.ino}`) { this.reason = 'vault_identity_changed'; await this.close(); }
      await this.start();
      const value = await this.request('drain') as { paths?: unknown; lost?: unknown };
      if (!Array.isArray(value.paths) || value.paths.length > 10000 || value.paths.some(p => typeof p !== 'string' || p.length > 32768) || value.lost !== null && typeof value.lost !== 'string') throw new Error('Invalid watcher response');
      for (const relative of value.paths as string[]) this.backlog.add(relative);
      if (this.backlog.size > 10000) { this.backlog.clear(); this.reason = 'watcher_overflow'; }
      if (value.lost) { this.reason = String(value.lost); await this.close(); await this.start(); }
    } catch { this.reason = 'watcher_unavailable'; await this.close(); }
    if (!this.reason && Date.now() - this.checkedAt > 3600000) this.reason = 'periodic_reconciliation';
    return { paths: [...this.backlog], reason: this.reason };
  }
  completed(snapshot: ChangeSnapshot, full: boolean) {
    for (const relative of snapshot.paths) this.backlog.delete(relative);
    if (full) { this.reason = this.child ? null : 'watcher_unavailable'; this.checkedAt = Date.now(); }
  }
  async close() {
    const child = this.child; if (!child) return;
    this.child = undefined;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end(); await closed;
  }
}
