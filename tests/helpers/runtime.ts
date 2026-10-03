import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import type { Config } from '@engramweave/contracts';

const isolationRoot = path.resolve('.local/test-runs');

export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function isolatedRuntime() {
  await mkdir(isolationRoot, { recursive: true });
  const root = await mkdtemp(path.join(isolationRoot, 'runtime-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  const config: Config = { config_version: 1, vault_path: vault, data_dir: path.join(root, 'data'), host: '127.0.0.1', port: await unusedPort() };
  return { root, config, async cleanup() {
    const resolved = path.resolve(root);
    const relative = path.relative(isolationRoot, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup target');
    await rm(resolved, { recursive: true, force: true });
  } };
}
