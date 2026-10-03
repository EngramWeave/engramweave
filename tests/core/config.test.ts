import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, validateConfig } from '../../packages/core/src/config.js';
import { isolatedRuntime } from '../helpers/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() { const result = await isolatedRuntime(); cleanups.push(result.cleanup); return result; }

describe('single Vault configuration boundary', () => {
  it('loads exact configuration without creating Vault or data directories', async () => {
    const { root, config } = await fixture();
    const filename = path.join(root, 'config.json');
    await writeFile(filename, JSON.stringify(config));
    expect(await loadConfig(filename)).toEqual(config);
    expect(await readdir(config.vault_path)).toEqual([]);
    expect(await readdir(root)).toEqual(['config.json', 'vault']);
  });
  it.each([
    { host: '0.0.0.0' }, { host: 'localhost' }, { port: 0 }, { port: 65536 },
    { port: 43127.5 }, { port: '43127' }, { config_version: 2 }, { future: 'option' },
    { vault_path: 'relative-vault' }, { data_dir: 'relative-data' },
  ])('rejects invalid fields %j', async change => {
    const { config } = await fixture();
    await expect(validateConfig({ ...config, ...change })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
  it('rejects Vault-contained, equal, and enclosing data directories', async () => {
    const { root, config } = await fixture();
    for (const data_dir of [config.vault_path, path.join(config.vault_path, 'state'), root]) {
      await expect(validateConfig({ ...config, data_dir })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    }
    expect(await readdir(config.vault_path)).toEqual([]);
  });
  it('resolves a junction ancestor before allowing a future data directory', async () => {
    const { root, config } = await fixture();
    const alias = path.join(root, 'vault-alias');
    await symlink(config.vault_path, alias, 'junction');
    await expect(validateConfig({ ...config, data_dir: path.join(alias, 'future', 'data') })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(await readdir(config.vault_path)).toEqual([]);
  });
  it('accepts a sibling with a shared textual prefix and rejects unavailable paths', async () => {
    const { config } = await fixture();
    const data_dir = `${config.vault_path}-data`;
    expect((await validateConfig({ ...config, data_dir })).data_dir).toBe(data_dir);
    await mkdir(config.data_dir);
    await writeFile(path.join(config.data_dir, 'file'), 'not a directory');
    await expect(validateConfig({ ...config, vault_path: path.join(config.vault_path, 'missing') })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(validateConfig({ ...config, data_dir: path.join(config.data_dir, 'file') })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});
