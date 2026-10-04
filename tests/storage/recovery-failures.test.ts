import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as promises from 'node:fs/promises';
import path from 'node:path';
import { recoverDatabase } from '../../packages/core/src/storage/recover.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { assetHashes } from '../helpers/recovery.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
vi.mock('node:fs/promises', { spy: true });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  await mkdir(isolated.config.data_dir);
  await writeFile(path.join(isolated.config.data_dir, 'core.sqlite'), 'original corrupt database');
  await writeDocument(isolated.config.vault_path, '20_Sources/item.md', manualSource('filetruth'));
  return isolated;
}

it('preserves partially isolated files and reports exact recovery paths when journal isolation fails', async () => {
  const { config } = await fixture();
  await writeFile(path.join(config.data_dir, 'core.sqlite-journal'), 'original journal');
  const hashes = await assetHashes(config.vault_path);
  const actual = await vi.importActual<typeof promises>('node:fs/promises');
  vi.spyOn(promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).endsWith('core.sqlite-journal')) throw Object.assign(new Error('Injected isolation failure'), { code: 'EACCES' });
    return actual.rename(from, to);
  });
  let error: CoreError | undefined;
  try { await recoverDatabase(config); } catch (caught) { error = caught as CoreError; }
  expect(error).toMatchObject({ code: 'DATABASE_ERROR', details: { isolated_files: ['core.sqlite'], cause_code: 'IO_ERROR' } });
  const backup = error!.details!.backup_dir as string;
  expect(await readFile(path.join(backup, 'core.sqlite'), 'utf8')).toBe('original corrupt database');
  expect(await readFile(path.join(config.data_dir, 'core.sqlite-journal'), 'utf8')).toBe('original journal');
  await expect(readFile(path.join(config.data_dir, 'core.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await assetHashes(config.vault_path)).toEqual(hashes);
  expect(await readdir(config.data_dir)).not.toContain('instance.lock');
});

it('keeps old backups and a failed Job diagnostic when rebuilding the fresh database fails, then preserves backups on another recovery', async () => {
  const { config } = await fixture(); const hashes = await assetHashes(config.vault_path);
  const actual = await vi.importActual<typeof promises>('node:fs/promises');
  const spy = vi.spyOn(promises, 'readdir').mockImplementation(async (...args: Parameters<typeof promises.readdir>) => {
    if (String(args[0]) === path.join(config.vault_path, '20_Sources')) throw Object.assign(new Error('Injected enumeration failure'), { code: 'EACCES' });
    return actual.readdir(...args);
  });
  let error: CoreError | undefined;
  try { await recoverDatabase(config); } catch (caught) { error = caught as CoreError; }
  spy.mockRestore();
  expect(error).toMatchObject({ code: 'DATABASE_ERROR', details: { isolated_files: ['core.sqlite'], rebuild_job: { status: 'failed', error: { code: 'IO_ERROR' } } } });
  const backup = error!.details!.backup_dir as string;
  expect(await readFile(path.join(backup, 'core.sqlite'), 'utf8')).toBe('original corrupt database');
  const fresh = new Database(path.join(config.data_dir, 'core.sqlite'), { readonly: true });
  expect(fresh.prepare('SELECT index_generation FROM meta').get()).toEqual({ index_generation: 0 });
  expect(fresh.prepare('SELECT status FROM jobs').get()).toEqual({ status: 'failed' }); fresh.close();
  const retried = await recoverDatabase(config);
  expect(retried.job.status).toBe('succeeded'); expect(retried.backup_dir).not.toBe(backup);
  expect(await readFile(path.join(backup, 'core.sqlite'), 'utf8')).toBe('original corrupt database');
  expect((await readdir(config.data_dir)).filter(name => name.startsWith('recovery-'))).toHaveLength(2);
  expect(await assetHashes(config.vault_path)).toEqual(hashes);
  if (process.env.P1_EVIDENCE === '1') {
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile('.local/p1/evidence/t10-recovery-failure.json', JSON.stringify({ initial_error: { code: error!.code, details: error!.details }, explicit_retry: retried, before_hashes: hashes, after_hashes: await assetHashes(config.vault_path), earlier_backup_preserved: true }, null, 2));
  }
});
