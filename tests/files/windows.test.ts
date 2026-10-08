import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { windowsAttributes, retainWindowsAttributes } from '../../packages/core/src/files/windows.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('reads native Hidden and ReparsePoint flags with literal Unicode paths and preserves file bytes', async () => {
  const isolated = await isolatedRuntime();
  cleanups.push(isolated.cleanup);
  const vault = isolated.config.vault_path;
  const relative = "20_Sources/中文 ; ' $().md";
  await writeDocument(vault, relative, 'original bytes');
  await writeDocument(vault, '20_Sources/hidden.md', 'hidden bytes');
  const regular = path.join(vault, relative);
  const hidden = path.join(vault, '20_Sources/hidden.md');
  const directory = path.join(vault, '20_Sources/hidden-directory');
  await mkdir(directory);
  const junction = path.join(vault, 'linked-directory');
  await symlink(path.join(vault, '20_Sources'), junction, 'junction');
  const attrib = path.join(process.env.SystemRoot!, 'System32/attrib.exe');
  await promisify(execFile)(attrib, ['+H', hidden], { windowsHide: true });
  await promisify(execFile)(attrib, ['+H', directory], { windowsHide: true });
  expect(
    await windowsAttributes([vault, regular, hidden, directory, junction]),
  ).toEqual([
    { path: vault, hidden: false, reparse: false },
    { path: regular, hidden: false, reparse: false },
    { path: hidden, hidden: true, reparse: false },
    { path: directory, hidden: true, reparse: false },
    { path: junction, hidden: false, reparse: true },
  ]);
  expect(await readFile(regular, 'utf8')).toBe('original bytes');
  expect(await readFile(hidden, 'utf8')).toBe('hidden bytes');
});

it('rejects an unavailable attribute batch without leaking native path diagnostics', async () => {
  const isolated = await isolatedRuntime();
  cleanups.push(isolated.cleanup);
  expect(await windowsAttributes([])).toEqual([]);
  await expect(
    windowsAttributes([
      isolated.config.vault_path,
      path.join(isolated.root, 'missing'),
    ]),
  ).rejects.toMatchObject({
    code: 'IO_ERROR',
    message: 'Windows file attributes could not be inspected',
  });
});

it('returns fresh attributes and isolates a failed request while concurrent callers share the helper', async () => {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  const release = retainWindowsAttributes(); cleanups.push(release);
  await writeDocument(isolated.config.vault_path, '20_Sources/live.md', 'Retained bytes');
  const filename = path.join(isolated.config.vault_path, '20_Sources/live.md');
  expect((await windowsAttributes([filename]))[0]?.hidden).toBe(false);
  await promisify(execFile)(path.join(process.env.SystemRoot!, 'System32/attrib.exe'), ['+H', filename], { windowsHide: true });
  const values = await Promise.allSettled([windowsAttributes([filename]), windowsAttributes([path.join(isolated.root, 'absent')]), windowsAttributes([isolated.config.vault_path, filename])]);
  expect(values[0]).toMatchObject({ status: 'fulfilled', value: [{ path: filename, hidden: true }] });
  expect(values[1]).toMatchObject({ status: 'rejected', reason: { code: 'IO_ERROR' } });
  expect(values[2]).toMatchObject({ status: 'fulfilled', value: [{ hidden: false }, { path: filename, hidden: true }] });
  await release(); await release();
  expect((await windowsAttributes([filename]))[0]?.hidden).toBe(true);
  expect(await readFile(filename, 'utf8')).toBe('Retained bytes');
});
