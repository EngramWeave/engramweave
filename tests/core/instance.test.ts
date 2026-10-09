import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { startCore } from '../../packages/core/src/main.js';
import { isolatedRuntime, unusedPort } from '../helpers/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() { const result = await isolatedRuntime(); cleanups.push(result.cleanup); return result; }

describe('real runtime ownership', () => {
  it('serves real loopback HTTP, stops and restarts without changing the Vault or token', async () => {
    const { config } = await fixture();
    const first = await startCore(config);
    cleanups.push(first.close);
    const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const health = await fetch(`http://127.0.0.1:${config.port}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ready' });
    await first.close();
    const second = await startCore(config);
    cleanups.push(second.close);
    expect(second.instance_id).not.toBe(first.instance_id);
    expect(await readFile(path.join(config.data_dir, 'token'), 'utf8')).toBe(token);
    expect(await readdir(config.vault_path)).toEqual([]);
    expect(await readdir(config.data_dir)).toEqual(['core.sqlite', 'instance.lock', 'semantic.sqlite', 'token']);
  });
  it('rejects second instances on both the same port and a different port before modifying ownership', async () => {
    const { config } = await fixture();
    const first = await startCore(config);
    cleanups.push(first.close);
    const lock = await readFile(path.join(config.data_dir, 'instance.lock'), 'utf8');
    const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
    await expect(startCore(config)).rejects.toMatchObject({ code: 'PORT_CONFLICT' });
    await expect(startCore({ ...config, port: await unusedPort() })).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
    expect(await readFile(path.join(config.data_dir, 'instance.lock'), 'utf8')).toBe(lock);
    expect(await readFile(path.join(config.data_dir, 'token'), 'utf8')).toBe(token);
    expect((await fetch(`http://127.0.0.1:${config.port}/v1/health`)).status).toBe(200);
  });
  it('does not write data files if an unrelated service owns the HTTP port', async () => {
    const { config } = await fixture();
    const other = net.createServer();
    await new Promise<void>(resolve => other.listen(config.port, config.host, resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => other.close(error => error ? reject(error) : resolve())));
    await expect(startCore(config)).rejects.toMatchObject({ code: 'PORT_CONFLICT' });
    await expect(readdir(config.data_dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(config.vault_path)).toEqual([]);
  });
  it('refuses uncertain residual metadata without killing the recorded live process', async () => {
    const { config } = await fixture();
    await mkdir(config.data_dir);
    const lock = JSON.stringify({ pid: process.pid });
    await writeFile(path.join(config.data_dir, 'instance.lock'), lock);
    await expect(startCore(config)).rejects.toMatchObject({ code: 'INSTANCE_UNCERTAIN' });
    expect(await readFile(path.join(config.data_dir, 'instance.lock'), 'utf8')).toBe(lock);
    expect(await readdir(config.data_dir)).toEqual(['instance.lock']);
  });
});
