import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { FileProblem } from './read.js';
import { windowsFilesExecutable } from './native-path.js';
import { normalizeVaultPath } from './paths.js';
import { formalPath } from '../changesets/paths.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { regularRead } from '../execution/settings.js';
import { resolveVaultDirectory } from './paths.js';

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
  async run(vault: string, relative: string, stem: string, before: string, after: string, manifest: string, recover = false, payload?: { manifest_bytes: string; replacement_bytes: string }, remove = false, mkdir = false, check = false) {
    if (this.pending) throw new Error('Property commits must be sequential');
    if (!this.child) this.start();
    return new Promise<{ mtime: number }>((resolve, reject) => {
      const timer = setTimeout(() => { this.child?.kill(); this.fail(); }, 30_000);
      this.pending = { resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify({ vault, relative, stem, before, after, manifest, recover, delete: remove, mkdir, check, ...payload }) + '\n');
    });
  }
  async checkFile(vault: string, relative: string, revision: string) {
    normalizeVaultPath(relative);
    await this.run(vault, relative, '', revision, '', '', false, undefined, false, false, true);
  }
  async remove(vault: string, relative: string, revision: string) {
    if (!/^20_Sources\/.+\.md$/i.test(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\:\x00-\x1f]/.test(segment))) throw new Error('Deletion requires an explicit Source Record path');
    await this.run(vault, relative, '', revision, '', '', false, undefined, true);
  }
  async ensureTaskDirectory(vault: string, relative: string) {
    normalizeVaultPath(relative);
    if (!(relative === '70_ChangeSets' || /^70_ChangeSets\/[0-9a-f-]+(?:\/candidates(?:\/.+)?)?$/.test(relative) || relative === '90_System/Prompts')) throw new Error('Only task directories may be created');
    await this.run(vault, relative, '', '', '', '', false, undefined, false, true);
  }
  async ensureFormalDirectory(vault: string, relative: string) {
    formalPath(relative, true);
    await this.run(vault, relative, '', '', '', '', false, undefined, false, true);
  }
  async createFormal(vault: string, relative: string, bytes: Buffer, revision: string, stagingId: string = randomUUID()) {
    formalPath(relative);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(stagingId)) throw new Error('Invalid staging identity');
    const stem = `.engramweave-capture-${stagingId}`, parent = path.posix.dirname(relative);
    const directory = await resolveVaultDirectory(vault, parent);
    const prior = await regularRead(path.join(directory, `${stem}.tmp`), 5 * 1024 * 1024);
    // The accepted receipt owns this exact nonce. Retire an interrupted staging file,
    // with native identity/hash guards, without ever truncating a formal destination.
    if (prior) await this.run(vault, `${parent}/${stem}.tmp`, '', createHash('sha256').update(prior).digest('hex'), '', '', false, undefined, true);
    await this.run(vault, relative, stem, '', revision, '', false, { manifest_bytes: '', replacement_bytes: bytes.toString('base64') });
  }
  async removeCandidate(vault: string, relative: string, revision: string) {
    normalizeVaultPath(relative);
    if (!/^70_ChangeSets\/[0-9a-f-]+\/(?:manifest\.json|candidates\/.+\.md)$/i.test(relative)) throw new Error('Only explicit candidate files may be removed');
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
