import { afterEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import * as promises from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime } from '../helpers/http.js';
import { submitCapture } from '../helpers/capture.js';
import { manualSource } from '../helpers/fixtures.js';
vi.mock('node:fs/promises', { spy: true });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('fails explicitly when hard-link publication is unavailable and does not fall back to copy or rename', async () => {
  const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
  vi.spyOn(promises, 'link').mockRejectedValue(Object.assign(new Error('Injected unsupported hard link'), { code: 'ENOTSUP' }));
  const copy = vi.spyOn(promises, 'copyFile'); const rename = vi.spyOn(promises, 'rename');
  expect(await submitCapture(request, '20_Sources/unavailable.md', manualSource())).toMatchObject({ status: 500, body: { error: { code: 'IO_ERROR' } } });
  expect(await readdir(path.join(config.vault_path, '20_Sources'))).toEqual([]);
  expect(copy).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
});

it('removes only its owned partial temporary file after an actual partial write followed by an injected disk-full failure', async () => {
  const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
  const actual = await vi.importActual<typeof promises>('node:fs/promises');
  vi.spyOn(promises, 'open').mockImplementation(async (...args: Parameters<typeof promises.open>) => {
    const handle = await actual.open(...args);
    if (path.basename(String(args[0])).startsWith('.engramweave-capture-')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => { await write(Buffer.from(data as Buffer).subarray(0, 10)); throw Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' }); };
    }
    return handle;
  });
  const publish = vi.spyOn(promises, 'link');
  expect(await submitCapture(request, '20_Sources/partial.md', manualSource())).toMatchObject({ status: 500 });
  expect(publish).not.toHaveBeenCalled(); expect(await readdir(path.join(config.vault_path, '20_Sources'))).toEqual([]);
});

it('rejects a replaced temporary inode before publication and does not delete the replacement', async () => {
  const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
  const actual = await vi.importActual<typeof promises>('node:fs/promises');
  let replaced: string | undefined;
  vi.spyOn(promises, 'open').mockImplementation(async (...args: Parameters<typeof promises.open>) => {
    const handle = await actual.open(...args);
    if (path.basename(String(args[0])).startsWith('.engramweave-capture-')) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        replaced = String(args[0]);
        await actual.rename(replaced, `${replaced}.moved`);
        await actual.writeFile(replaced, 'unrelated replacement bytes');
      };
    }
    return handle;
  });
  const publish = vi.spyOn(promises, 'link');
  expect(await submitCapture(request, '20_Sources/replaced.md', manualSource())).toMatchObject({ status: 500 });
  expect(publish).not.toHaveBeenCalled();
  expect(await readFile(replaced!, 'utf8')).toBe('unrelated replacement bytes');
  expect(await readdir(path.join(config.vault_path, '20_Sources'))).not.toContain('replaced.md');
});
