import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { humanFixture } from '../helpers/human-review.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';
import { CoreError } from '../../packages/core/src/errors.js';

it('confirms one Draft, marks only explicit siblings and never discards restored files on replay or restart', async () => {
  const f = await humanFixture(false);
  try {
    const sibling = '30_Drafts/sibling.md'; const retained = '30_Drafts/retained.md';
    const original = await readFile(path.join(f.config.vault_path, f.draftPath), 'utf8');
    await writeFile(path.join(f.config.vault_path, sibling), original); await writeFile(path.join(f.config.vault_path, retained), original);
    const request = { ...await f.request('complete', 'My intent'), discard_drafts: [{ path: sibling, revision: (await readDraft(f.config.vault_path, sibling)).revision }] };
    await f.human.submit(request);
    expect(await f.human.selection(f.sourcePath)).toBe(f.draftPath);
    expect((await readDraft(f.config.vault_path, sibling)).lifecycle_status).toBe('discarded');
    expect(await readFile(path.join(f.config.vault_path, f.draftPath), 'utf8')).toBe(original);
    expect(await readFile(path.join(f.config.vault_path, retained), 'utf8')).toBe(original);
    await writeFile(path.join(f.config.vault_path, sibling), original);
    await f.human.submit(request); const restarted = f.create(); await restarted.initialize(); await restarted.submit(request);
    expect((await readDraft(f.config.vault_path, sibling)).lifecycle_status).toBe('active');
    expect(await restarted.context(f.sourcePath, f.draftPath)).toEqual({ selected_draft: f.draftPath, intent: 'My intent' });
  } finally { await f.close(); }
});
it('refuses the selected Draft, other Sources, duplicate targets and stale cleanup before accepting', async () => {
  const f = await humanFixture(false);
  try {
    const sibling = '30_Drafts/sibling.md'; const filename = path.join(f.config.vault_path, sibling);
    const original = await readFile(path.join(f.config.vault_path, f.draftPath), 'utf8'); await writeFile(filename, original);
    const target = { path: sibling, revision: (await readDraft(f.config.vault_path, sibling)).revision };
    for (const targets of [[{ path: f.draftPath, revision: (await readDraft(f.config.vault_path, f.draftPath)).revision }], [target, target], [{ ...target, revision: 'a'.repeat(64) }]]) {
      const request = { ...await f.request('complete'), discard_drafts: targets };
      await expect(f.human.submit(request)).rejects.toBeInstanceOf(CoreError);
      expect((await f.human.receipt(request.request_id)).status).toBe('not_found');
    }
    await writeFile(filename, original.replace(f.sourcePath, '20_Sources/other.md'));
    await expect(f.human.submit({ ...await f.request('complete'), discard_drafts: [{ path: sibling, revision: (await readDraft(f.config.vault_path, sibling)).revision }] })).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
    expect(await readFile(path.join(f.config.vault_path, f.sourcePath), 'utf8')).toContain('processing_status: compiled');
  } finally { await f.close(); }
});
it('recovers interrupted sibling marking as the original action without losing the new selection', async () => {
  const f = await humanFixture(false); let calls = 0;
  const originalRun = PropertyNative.prototype.run;
  const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this: PropertyNative, ...args) {
    if (++calls === 2) throw new CoreError('IO_ERROR', 'Interrupted sibling lifecycle write');
    return originalRun.apply(this, args);
  });
  try {
    const sibling = '30_Drafts/sibling.md'; await writeFile(path.join(f.config.vault_path, sibling), await readFile(path.join(f.config.vault_path, f.draftPath)));
    const request = { ...await f.request('complete', 'Recovered intent'), discard_drafts: [{ path: sibling, revision: (await readDraft(f.config.vault_path, sibling)).revision }] };
    await expect(f.human.submit(request)).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect((await f.human.receipt(request.request_id)).status).toBe('unfinished'); expect(f.human.busy()).toBe(true);
    mock.mockRestore(); const recovered = f.create(); await recovered.initialize();
    expect(recovered.busy()).toBe(false); expect((await recovered.receipt(request.request_id)).status).toBe('completed');
    expect((await readDraft(f.config.vault_path, sibling)).lifecycle_status).toBe('discarded');
    expect(await recovered.context(f.sourcePath, f.draftPath)).toEqual({ selected_draft: f.draftPath, intent: 'Recovered intent' });
  } finally { mock.mockRestore(); await f.close(); }
});
it('does not repeat a completed sibling step after a later sibling fails and the first file is restored manually', async () => {
  const f = await humanFixture(false); const first = '30_Drafts/first.md'; const second = '30_Drafts/second.md';
  const original = await readFile(path.join(f.config.vault_path, f.draftPath), 'utf8');
  await writeFile(path.join(f.config.vault_path, first), original); await writeFile(path.join(f.config.vault_path, second), original);
  const originalRun = PropertyNative.prototype.run;
  const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this: PropertyNative, ...args) {
    if (args[1] === second) throw new CoreError('IO_ERROR', 'Interrupted second sibling'); return originalRun.apply(this, args);
  });
  try {
    const request = { ...await f.request('complete'), discard_drafts: await Promise.all([first, second].map(async path => ({ path, revision: (await readDraft(f.config.vault_path, path)).revision }))) };
    await expect(f.human.submit(request)).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect((await readDraft(f.config.vault_path, first)).lifecycle_status).toBe('discarded');
    await writeFile(path.join(f.config.vault_path, first), original); mock.mockRestore();
    const recovered = f.create(); await recovered.initialize();
    expect((await readDraft(f.config.vault_path, first)).lifecycle_status).toBe('active');
    expect((await readDraft(f.config.vault_path, second)).lifecycle_status).toBe('discarded');
    expect(await recovered.selection(f.sourcePath)).toBe(f.draftPath);
  } finally { mock.mockRestore(); await f.close(); }
});
