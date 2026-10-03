import { afterEach, describe, expect, it, vi } from 'vitest';
import { symlink, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { normalizeVaultPath, resolveMarkdown } from '../../packages/core/src/files/paths.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { LIMITS } from '@engramweave/contracts';
import { isolatedRuntime } from '../helpers/runtime.js';
import { copyRealSamples, realSamples, sha256, writeDocument } from '../helpers/fixtures.js';
import * as promises from 'node:fs/promises';
vi.mock('node:fs/promises', { spy: true });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() { const result = await isolatedRuntime(); cleanups.push(result.cleanup); return result; }

describe('read-only filesystem boundary', () => {
  it.each(['../a.md', '20_Sources/../a.md', 'C:/a.md', '//server/a.md', '20_Sources/a.md:ads', '20_Sources\\a.md', '20_Sources/CON.md', '20_Sources/a /b.md'])('rejects unsafe path %s', input => {
    expect(() => normalizeVaultPath(input)).toThrow();
  });
  it('reads a real copy using raw-byte revision and rejects a junction escape', async () => {
    const { config } = await fixture();
    await copyRealSamples(config.vault_path);
    const sample = realSamples[0]!;
    const result = await readMarkdown(config.vault_path, sample.path);
    expect(result.revision).toBe(sample.hash);
    expect(result.size).toBe(1244);
    expect(sha256(await readFile(path.join(config.vault_path, sample.path)))).toBe(sample.hash);
    await symlink(path.join(config.vault_path, '20_Sources/Web'), path.join(config.vault_path, '20_Sources/linked'), 'junction');
    await expect(resolveMarkdown(config.vault_path, `20_Sources/linked/2026-10/${sample.name}`)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
    await expect(resolveMarkdown(config.vault_path, '.obsidian/a.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
  });
  it('never truncates a file larger than the Markdown limit', async () => {
    const { config } = await fixture();
    await writeDocument(config.vault_path, '20_Sources/large.md', Buffer.alloc(LIMITS.markdown_bytes + 1, 65));
    await expect(readMarkdown(config.vault_path, '20_Sources/large.md')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', state: 'unsupported' });
  });
  it('rejects an actual Windows Hidden file without changing its content', async () => {
    const { config } = await fixture();
    await writeDocument(config.vault_path, '20_Sources/hidden.md', 'hidden content');
    const filename = path.join(config.vault_path, '20_Sources/hidden.md');
    await promisify(execFile)(path.join(process.env.SystemRoot!, 'System32/attrib.exe'), ['+H', filename], { windowsHide: true });
    await expect(readMarkdown(config.vault_path, '20_Sources/hidden.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
    expect(await readFile(filename, 'utf8')).toBe('hidden content');
  });
  it('rejects ambiguous case-folded sibling names before opening a document', async () => {
    const { config } = await fixture();
    await writeDocument(config.vault_path, '20_Sources/one.md', 'content');
    const originalReadDirectory = (await vi.importActual<typeof promises>('node:fs/promises')).readdir;
    vi.spyOn(promises, 'readdir').mockImplementation(async (...args) => {
      if (args[0] === path.join(config.vault_path, '20_Sources')) return ['one.md', 'ONE.md'] as never;
      return Reflect.apply(originalReadDirectory, promises, args);
    });
    await expect(resolveMarkdown(config.vault_path, '20_Sources/one.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
  });
  it('retries a file changed during reading once, then rejects its partial content', async () => {
    const { config } = await fixture();
    await writeDocument(config.vault_path, '20_Sources/changing.md', 'initial content');
    const filename = path.join(config.vault_path, '20_Sources/changing.md');
    const originalOpen = (await vi.importActual<typeof promises>('node:fs/promises')).open;
    let attempts = 0;
    vi.spyOn(promises, 'open').mockImplementation(async (...args) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (args[0] === filename) {
        attempts++;
        const originalRead = handle.read;
        let changed = false;
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: unknown[]) => {
          const value = await Reflect.apply(originalRead, handle, readArgs);
          if (!changed) { changed = true; await promises.appendFile(filename, '\nconcurrent change'); }
          return value;
        });
      }
      return handle;
    });
    await expect(readMarkdown(config.vault_path, '20_Sources/changing.md')).rejects.toMatchObject({ code: 'FILE_UNSTABLE' });
    expect(attempts).toBe(2);
  });
});
