import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import * as promises from 'node:fs/promises';
import path from 'node:path';
import { resolveReference } from '../../packages/core/src/source/references.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
vi.mock('node:fs/promises', { spy: true });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('bounded Wiki Links and inert external locators', () => {
  it('requires an explicit asset for a local Source Record, allowing only an external source locator as fallback', () => {
    const local = parseMarkdown('20_Sources/A1/local.source.md', Buffer.from(manualSource('Record description', 'source: "[[./paper.pdf]]"\n')));
    expect(local).toMatchObject({ state: 'invalid', asset: null, diagnostics: [{ code: 'ASSET_REQUIRED' }] });
    const external = parseMarkdown('20_Sources/A1/external.source.md', Buffer.from(manualSource('Record description', 'source: https://example.invalid/original\n')));
    expect(external).toMatchObject({ state: 'ready', asset: { kind: 'external_ref', availability: 'unverified' } });
  });
  it('resolves only Vault paths or explicit Record-relative paths, retaining raw alias and anchor', async () => {
    const { config, cleanup } = await isolatedRuntime(); cleanups.push(cleanup);
    await writeDocument(config.vault_path, '20_Sources/A1/paper.source.md', 'record');
    await writeDocument(config.vault_path, '20_Sources/A1/paper.pdf', Buffer.from([0, 255, 127]));
    const record = '20_Sources/A1/paper.source.md';
    expect(await resolveReference(config.vault_path, record, '[[./paper.pdf#page=2|原始附件]]', false)).toEqual({
      raw: '[[./paper.pdf#page=2|原始附件]]', target_path: '20_Sources/A1/paper.pdf', anchor: 'page=2', alias: '原始附件', availability: 'available',
    });
    expect(await resolveReference(config.vault_path, '40_Knowledge/K1.md', '[[20_Sources/A1/paper.source#intro|paper]]', true)).toMatchObject({ target_path: record, availability: 'available', anchor: 'intro', alias: 'paper' });
    expect(await resolveReference(config.vault_path, record, '[[paper.pdf]]', false)).toMatchObject({ target_path: 'paper.pdf', availability: 'missing' });
    expect(await resolveReference(config.vault_path, record, '[[./absent.pdf]]', false)).toMatchObject({ target_path: '20_Sources/A1/absent.pdf', availability: 'missing' });
    await writeDocument(config.vault_path, '20_Sources/A1/paper.source', 'extensionless collision');
    expect(await resolveReference(config.vault_path, record, '[[20_Sources/A1/paper.source]]', true)).toMatchObject({ availability: 'ambiguous', target_path: null });
    const original = (await vi.importActual<typeof promises>('node:fs/promises')).readdir;
    vi.spyOn(promises, 'readdir').mockImplementation(async (...args: Parameters<typeof promises.readdir>) => {
      const names = await original(...args);
      return String(args[0]).replaceAll('\\', '/').endsWith('/20_Sources/A1') ? [...names, 'PAPER.PDF'] as typeof names : names;
    });
    expect(await resolveReference(config.vault_path, record, '[[./paper.pdf]]', false)).toMatchObject({ availability: 'ambiguous' });
  });
  it('rejects traversal, Windows alias paths, excluded paths and junctions without reading binaries or opening schemes', async () => {
    const { config, root, cleanup } = await isolatedRuntime(); cleanups.push(cleanup);
    await mkdir(path.join(config.vault_path, '20_Sources/A1'), { recursive: true });
    const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.pdf'), 'private');
    await symlink(outside, path.join(config.vault_path, '20_Sources/A1/linked'), 'junction');
    await writeDocument(config.vault_path, '20_Sources/A1/visible.pdf', Buffer.from([0, 255, 127]));
    for (const raw of ['[[../../../outside/secret.pdf]]', '[[C:/private.pdf]]', '[[./paper.pdf:stream]]', '[[20_Sources/.hidden/paper.pdf]]', '[[./linked/secret.pdf]]', '[[30_Drafts/note]]']) {
      expect(await resolveReference(config.vault_path, '20_Sources/A1/paper.source.md', raw, raw.includes('30_Drafts')), raw).toMatchObject({ availability: 'outside_scope' });
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must remain unused'));
    const read = vi.spyOn(promises, 'readFile');
    expect(await resolveReference(config.vault_path, '20_Sources/A1/paper.source.md', '[[./visible.pdf]]', false)).toMatchObject({ availability: 'available' });
    for (const raw of ['https://example.invalid/no-network', 'http://127.0.0.1:9/no-network', 'zotero://select/library/items/ABC']) {
      expect(await resolveReference(config.vault_path, '40_Knowledge/K1.md', raw, true)).toMatchObject({ raw, availability: 'unverified', target_path: null });
    }
    for (const raw of ['javascript:alert(1)', 'file:///C:/private.pdf', 'obsidian://open', '[[bad|alias\nother]]', 'https://']) {
      expect(await resolveReference(config.vault_path, '40_Knowledge/K1.md', raw, true)).toMatchObject({ availability: 'unsupported' });
    }
    expect(fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
});
