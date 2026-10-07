import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedRuntime } from '../helpers/runtime.js';
import { readDraft, listDrafts } from '../../packages/core/src/drafts/files.js';

describe('User-edited Draft file boundaries', () => {
  it('reads UTF-8 BOM and empty lifecycle as active, and diagnoses invalid UTF-8 without rewriting it', async () => {
    const runtime = await isolatedRuntime();
    try {
      await mkdir(path.join(runtime.config.vault_path, '30_Drafts'));
      const relative = '30_Drafts/user.md';
      const text = '\uFEFF---\r\ntype: draft\r\ntitle: User candidate\r\nlifecycle_status:\r\nsources:\r\n  - "[[20_Sources/source.md]]"\r\n---\r\n\r\n用户修改的正文。\r\n';
      await writeFile(path.join(runtime.config.vault_path, relative), text);
      expect(await readDraft(runtime.config.vault_path, relative)).toMatchObject({ lifecycle_status: 'active', body: '\r\n用户修改的正文。\r\n', sources: ['20_Sources/source.md'] });
      await writeFile(path.join(runtime.config.vault_path, '30_Drafts/invalid.md'), Buffer.concat([Buffer.from(text), Buffer.from([0xff])]));
      await expect(readDraft(runtime.config.vault_path, '30_Drafts/invalid.md')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
      const list = await listDrafts(runtime.config.vault_path, '20_Sources/source.md');
      expect(list.items).toHaveLength(1);
      expect(list.diagnostics).toMatchObject([{ code: 'DRAFT_UNREADABLE', path: '30_Drafts/invalid.md' }]);
    } finally { await runtime.cleanup(); }
  });
});
