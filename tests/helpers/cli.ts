import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '@engramweave/contracts';

export async function standaloneCore(root: string, config: Config) {
  const filename = path.join(root, 'config.json');
  await writeFile(filename, JSON.stringify(config));
  const child = fork(path.resolve('packages/core/dist/main.js'), ['--config', filename], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let output = ''; let errors = '';
  const started = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('core_started')) resolve(); });
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    child.once('error', reject);
    child.once('exit', () => { if (!output.includes('core_started')) reject(new Error('Standalone Core did not start')); });
  });
  try { await started; }
  catch (error) { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } throw error; }
  const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
  const request = (route: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${config.port}${route}`, { ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers } });
  return { request, output: () => output, errors: () => errors, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.send({ type: 'stop' });
    const timer = setTimeout(() => child.kill(), 10_000);
    try { const [code] = await exited; if (code !== 0) throw new Error('Standalone Core did not stop normally'); }
    finally { clearTimeout(timer); }
  } };
}
