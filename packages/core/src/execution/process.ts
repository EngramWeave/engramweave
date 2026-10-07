import { spawn } from 'node:child_process';
import { CoreError } from '../errors.js';

/** Fixed executable/argument boundaries; model content travels only through stdin. */
export async function runProcess(executable: string, args: string[], input: string, options: {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; maxBytes?: number;
} = {}): Promise<string> {
  if (options.signal?.aborted) throw new CoreError('EXECUTION_FAILED', 'Execution was stopped');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let size = 0; let failure: CoreError | undefined;
    const stop = () => { failure ??= new CoreError('EXECUTION_FAILED', 'Execution stopped or exceeded its time limit'); child.kill(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      size += Buffer.byteLength(data);
      if (size > (options.maxBytes ?? 4_000_000)) { failure = new CoreError('EXECUTION_FAILED', 'Executor output exceeds the limit'); child.kill(); }
      else output += data;
    });
    // Drain diagnostics without returning potentially sensitive provider content.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => { failure = new CoreError('EXECUTION_FAILED', 'Executor could not be started'); });
    child.once('close', code => {
      options.signal?.removeEventListener('abort', stop);
      if (failure) reject(failure);
      else if (code !== 0) reject(new CoreError('EXECUTION_FAILED', 'Executor failed; check configuration, authentication and availability'));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
