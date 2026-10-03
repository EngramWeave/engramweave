import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';

it('runs the built standalone CLI and stops through its owned IPC channel with redacted logs', async () => {
  const isolated = await isolatedRuntime();
  const filename = path.join(isolated.root, 'config.json');
  await writeFile(filename, JSON.stringify(isolated.config));
  const child = fork(path.resolve('packages/core/dist/main.js'), ['--config', filename], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  try {
    const startup = new Promise<void>((resolve, reject) => {
      const check = () => { if (output.includes('core_started')) resolve(); };
      child.stdout!.on('data', check);
      child.once('exit', () => { if (!output.includes('core_started')) reject(new Error(`CLI startup failed: ${errors}`)); });
    });
    await startup;
    const token = await readFile(path.join(isolated.config.data_dir, 'token'), 'utf8');
    const url = `http://127.0.0.1:${isolated.config.port}`;
    const health = await fetch(`${url}/v1/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: 'degraded', core_version: '0.1.0', api_version: '1' });
    const query = await fetch(`${url}/v1/health?secret=${token}`);
    expect(query.status).toBe(400);
    const unauthorized = await fetch(`${url}/v1/status`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(authorized.status).toBe(404);
    child.send({ type: 'stop' });
    expect(await exited).toEqual([0, null]);
    expect(errors).toBe('');
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.event)).toEqual(['core_started', 'core_stopped']);
    expect(output).not.toContain(token);
    expect(output).not.toContain(isolated.config.vault_path);
    expect(output).not.toContain('secret');
    expect(await readdir(isolated.config.vault_path)).toEqual([]);
    expect(await readdir(isolated.config.data_dir)).toEqual(['token']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await isolated.cleanup();
  }
});
