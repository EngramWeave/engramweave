import { expect, it, vi } from 'vitest';
import { mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, httpCore, submitScan, finishedJob } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { VaultChanges } from '../../packages/core/src/discovery/changes.js';
import * as markdown from '../../packages/core/src/files/read.js';

it('refreshes only changed files, reconciles directory moves/deletes and preserves untouched hash-check timestamps', async () => {
  const f = await httpRuntime(async vault => {
    await writeDocument(vault, '20_Sources/a.md', manualSource('Before', 'processing_status: pending\n'));
    await writeDocument(vault, '40_Knowledge/keep.md', '# Untouched\nKeep exact bytes.');
    await writeDocument(vault, '40_Knowledge/folder/nested.md', '# Nested\nFolder move.');
  });
  const scan = async (mode = 'refresh') => finishedJob(f.request, (await submitScan(f.request, mode)).job.id);
  const document = async (relative: string) => (await f.request('/v1/documents?path=' + encodeURIComponent(relative))).json();
  try {
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'core_started', read_files: 3 } });
    // Consume Source normalization hints without assuming asynchronous watcher delivery timing.
    await scan(); const baseline = await document('40_Knowledge/keep.md');
    expect(await scan()).toMatchObject({ status: 'succeeded', processed_files: 0, summary: { scan_strategy: 'incremental', read_files: 0, unchanged: 3 } });
    const file = path.join(f.config.vault_path, '20_Sources/a.md');
    const bytes = await readFile(file, 'utf8'); await writeFile(file, bytes.replace('Before', 'After!'));
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'incremental', read_files: 1, updated: 1 } });
    expect((await document('20_Sources/a.md')).source_content).toBe('After!');
    expect((await document('40_Knowledge/keep.md')).indexed_at).toBe(baseline.indexed_at);
    await rename(path.join(f.config.vault_path, '40_Knowledge/folder'), path.join(f.config.vault_path, '40_Knowledge/moved'));
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { added: 1, missing: 1 } });
    expect((await document('40_Knowledge/moved/nested.md')).body).toContain('Folder move.');
    await rm(path.join(f.config.vault_path, '40_Knowledge/moved'), { recursive: true });
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { missing: 1 } });
    await writeDocument(f.config.vault_path, '40_Knowledge/fresh/new.md', '# Newly copied tree');
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { added: 1 } });
    const sourcesBeforeFull = (await (await f.request('/v1/sources')).json()).items;
    const knowledgeBeforeFull = (await (await f.request('/v1/search?path_prefix=40_Knowledge')).json()).items;
    expect(await scan('rebuild')).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'explicit_rebuild', read_files: 3 } });
    expect((await (await f.request('/v1/sources')).json()).items).toEqual(sourcesBeforeFull);
    expect((await (await f.request('/v1/search?path_prefix=40_Knowledge')).json()).items).toEqual(knowledgeBeforeFull);
  } finally { await f.cleanup(); }
}, 60000);

it('retains edits arriving during a scan and handles case-only renames without losing identity', async () => {
  const f = await httpRuntime(vault => writeDocument(vault, '40_Knowledge/note.md', '# Original'));
  const scan = async () => finishedJob(f.request, (await submitScan(f.request)).job.id);
  const document = async (relative: string) => (await f.request('/v1/documents?path=' + encodeURIComponent(relative))).json();
  try {
    await scan(); await scan();
    const file = path.join(f.config.vault_path, '40_Knowledge/note.md');
    await writeFile(file, '# First edit');
    const originalRead = markdown.readMarkdown;
    let edited = false;
    vi.spyOn(markdown, 'readMarkdown').mockImplementation(async (...args) => {
      const result = await originalRead(...args);
      if (!edited && args[1] === '40_Knowledge/note.md') { edited = true; await writeFile(file, '# Later edit'); }
      return result;
    });
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { read_files: 1 } });
    vi.restoreAllMocks();
    expect((await document('40_Knowledge/note.md')).index_stale).toBe(true);
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { read_files: 1 } });
    expect((await document('40_Knowledge/note.md')).body).toBe('# Later edit');
    const before = (await (await f.request('/v1/search?q=Later')).json()).items[0];
    await rename(file, path.join(f.config.vault_path, '40_Knowledge/NOTE.md'));
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { read_files: 1, added: 0, missing: 0 } });
    expect((await (await f.request('/v1/search?q=Later')).json()).items[0]).toMatchObject({ id: before.id, path: '40_Knowledge/NOTE.md', revision: before.revision });
    expect((await document('40_Knowledge/NOTE.md')).index_stale).toBe(false);
    await rename(path.join(f.config.vault_path, '40_Knowledge'), path.join(f.config.vault_path, '40_knowledge'));
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'incremental', read_files: 1, missing: 0, added: 0 } });
    expect((await (await f.request('/v1/search?q=Later')).json()).items[0]).toMatchObject({ id: before.id, path: '40_Knowledge/NOTE.md' });
  } finally { vi.restoreAllMocks(); await f.cleanup(); }
}, 60000);

it('keeps the published generation and dirty hints when a scan root is unavailable', async () => {
  const f = await httpRuntime(vault => writeDocument(vault, '40_Knowledge/note.md', '# Original'));
  const scan = async () => finishedJob(f.request, (await submitScan(f.request)).job.id);
  const root = path.join(f.config.vault_path, '40_Knowledge');
  const moved = path.join(f.config.vault_path, 'temporarily-unavailable');
  try {
    await scan(); await scan();
    const before = await (await f.request('/v1/status')).json();
    await rename(root, moved);
    expect(await scan()).toMatchObject({ status: 'failed', error: { code: 'IO_ERROR' } });
    expect((await (await f.request('/v1/status')).json()).index_generation).toBe(before.index_generation);
    expect(await (await f.request('/v1/search?q=Original')).json()).toMatchObject({ total: 1, index_generation: before.index_generation });
    await writeFile(path.join(moved, 'note.md'), '# Recovered edit'); await rename(moved, root);
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'incremental', read_files: 1, updated: 1 } });
    expect((await (await f.request('/v1/documents?path=40_Knowledge%2Fnote.md')).json()).body).toBe('# Recovered edit');
    await rename(f.config.vault_path, path.join(f.root, 'previous-vault'));
    await writeDocument(f.config.vault_path, '40_Knowledge/note.md', '# Replacement Vault');
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'vault_identity_changed', read_files: 1 } });
    expect((await (await f.request('/v1/documents?path=40_Knowledge%2Fnote.md')).json()).body).toBe('# Replacement Vault');
  } finally { await f.cleanup(); }
}, 60000);

it('rechecks an affected Asset without rehashing its unchanged Record and falls back after uncertainty or restart', async () => {
  const f = await httpRuntime(async vault => {
    await mkdir(path.join(vault, '80_Assets'), { recursive: true }); await writeFile(path.join(vault, '80_Assets/a.bin'), 'Asset');
    await writeDocument(vault, '20_Sources/record.source.md', manualSource('Only description', 'processing_status: pending\nasset: "[[80_Assets/a.bin]]"\n'));
    await writeDocument(vault, '40_Knowledge/keep.md', '# Unchanged');
  });
  let restored: Awaited<ReturnType<typeof httpCore>> | undefined;
  const scan = async () => finishedJob(f.request, (await submitScan(f.request)).job.id);
  const sources = async () => (await (await f.request('/v1/sources')).json()).items;
  try {
    await scan(); await scan(); const before = (await sources())[0];
    await rm(path.join(f.config.vault_path, '80_Assets/a.bin'));
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'incremental', read_files: 0 } });
    expect((await sources())[0]).toMatchObject({ revision: before.revision, asset: { availability: 'missing' } });
    const capture = vi.spyOn(VaultChanges.prototype, 'capture').mockResolvedValueOnce({ paths: [], reason: 'watcher_overflow' });
    expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'watcher_overflow', read_files: 2 } }); capture.mockRestore();
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 3600001);
    try { expect(await scan()).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'periodic_reconciliation', read_files: 2 } }); }
    finally { clock.mockRestore(); }
    await f.core.close();
    await writeFile(path.join(f.config.vault_path, '80_Assets/a.bin'), 'Restored while Core was stopped');
    restored = await httpCore(f.config);
    const first = await finishedJob(restored.request, (await submitScan(restored.request)).job.id);
    expect(first).toMatchObject({ status: 'succeeded', summary: { scan_strategy: 'full', scan_reason: 'core_started' } });
    expect((await sources())[0].asset.availability).toBe('available');
  } finally { vi.restoreAllMocks(); await restored?.core.close(); await f.cleanup(); }
}, 60000);
