import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PublishDraftRequest } from '@engramweave/contracts';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';
import { DraftPublications } from '../../packages/core/src/review/publication.js';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { getDocument } from '../../packages/core/src/storage/registry.js';

async function fixture(failAnalysis = false) {
  const f = await analyzerFixture(async task => { if (failAnalysis) throw new CoreError('EXECUTION_FAILED', 'fixture failure'); return emptyAnalysis(task); });
  const analysis = f.request(); await f.analyzer.submit(analysis); await f.analyzer.wait();
  const create = () => new DraftPublications(f.config, f.db, () => false, id => f.analyzer.get(id));
  const publication = create(); await publication.initialize();
  const request = async (): Promise<PublishDraftRequest> => {
    const source = await readMarkdown(f.config.vault_path, f.sourcePath); const draft = await readMarkdown(f.config.vault_path, f.draftPath);
    return { request_id: randomUUID(), source_path: f.sourcePath, source_revision: source.revision,
      draft_path: f.draftPath, draft_revision: draft.revision, analysis_id: analysis.request_id, target_path: '40_Knowledge/Approved.md',
      related_drafts: [{ path: f.draftPath, revision: draft.revision }] };
  };
  return { ...f, create, publication, request, analysis };
}
describe('explicit MVP Knowledge publication', () => {
  it('publishes current human-edited bytes, retains properties and body, archives Source last, and replays once', async () => {
    const f = await fixture();
    try {
      const sourceBefore = parseMarkdown(f.sourcePath, await readFile(path.join(f.config.vault_path, f.sourcePath)));
      await writeFile(path.join(f.config.vault_path, f.draftPath), `---\r\ntype: draft\r\ntitle: My edited title\r\nlifecycle_status: active\r\ncaptured_at: null\r\nannotation: "My note"\r\ncustom: [one, two]\r\nsources: ["[[${f.sourcePath}]]"]\r\n---\r\n# My edited title\r\n\r\nUser-edited exact body.\r\n`);
      const draftBefore = await readDraft(f.config.vault_path, f.draftPath);
      const req = await f.request(); const result = await f.publication.submit(req);
      expect(result.status).toBe('completed'); expect(result.reused).toBe(false);
      const formalFile = await readMarkdown(f.config.vault_path, req.target_path);
      const formal = parseMarkdown(req.target_path, formalFile.bytes);
      expect(formal.body_markdown).toBe(draftBefore.body); expect(formal.metadata).toMatchObject({ type: 'knowledge', captured_at: null, custom: ['one','two'], sources: [`[[${f.sourcePath}]]`], lifecycle_status: 'active' });
      expect(formal.annotation).toBe('My note'); expect(formal.metadata.mvp_publication_id).toBe(req.request_id);
      const sourceAfter = parseMarkdown(f.sourcePath, await readFile(path.join(f.config.vault_path, f.sourcePath)));
      expect(sourceAfter.processing_status).toBe('archived'); expect(sourceAfter.body_markdown).toBe(sourceBefore.body_markdown);
      expect(sourceAfter.annotation).toBe(sourceBefore.annotation); expect(sourceAfter.metadata.custom).toBe('preserve-me');
      expect((await readDraft(f.config.vault_path, f.draftPath)).lifecycle_status).toBe('discarded');
      expect(getDocument(f.db, req.target_path)?.revision).toBe(formalFile.revision);
      expect((await f.publication.submit(req)).reused).toBe(true);
      expect((await readdir(path.join(f.config.vault_path, '40_Knowledge'))).filter(name => name === 'Approved.md')).toHaveLength(1);
      const restarted = f.create(); await restarted.initialize(); expect((await restarted.submit(req)).reused).toBe(true);
      await expect(restarted.submit({ ...req, target_path: '40_Knowledge/Other.md' })).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
    } finally { await f.close(); }
  });
  it('requires an ended analysis attempt but permits failed Review/Relation', async () => {
    const f = await fixture(true);
    try {
      const req = await f.request();
      await expect(f.publication.submit({ ...req, analysis_id: randomUUID() })).rejects.toMatchObject({ code: 'JOB_BUSY' });
      expect((await f.publication.submit(req)).status).toBe('completed');
    } finally { await f.close(); }
  });
  it.each(['source','draft','target','new-related'] as const)('refuses %s conflicts without overwriting files or changing stage', async mode => {
    const f = await fixture();
    try {
      const req = await f.request();
      if (mode === 'source' || mode === 'draft') await writeFile(path.join(f.config.vault_path, mode === 'source' ? f.sourcePath : f.draftPath), `${await readFile(path.join(f.config.vault_path, mode === 'source' ? f.sourcePath : f.draftPath), 'utf8')}\nExternal edit\n`);
      if (mode === 'target') await writeFile(path.join(f.config.vault_path, req.target_path), 'Existing user knowledge');
      if (mode === 'new-related') await writeFile(path.join(f.config.vault_path, '30_Drafts/another.md'), await readFile(path.join(f.config.vault_path, f.draftPath)));
      await expect(f.publication.submit(req)).rejects.toMatchObject({ code: mode === 'target' ? 'PATH_CONFLICT' : 'SOURCE_CHANGED' });
      expect(parseMarkdown(f.sourcePath, await readFile(path.join(f.config.vault_path, f.sourcePath))).processing_status).toBe('compiled');
      expect((await readDraft(f.config.vault_path, f.draftPath)).lifecycle_status).toBe('active');
      if (mode === 'target') expect(await readFile(path.join(f.config.vault_path, req.target_path), 'utf8')).toBe('Existing user knowledge');
      else expect((await readdir(path.join(f.config.vault_path, '40_Knowledge'))).includes('Approved.md')).toBe(false);
    } finally { await f.close(); }
  });
  it('marks every related active Draft discarded, retains already discarded Draft bytes, and forbids a second final Draft', async () => {
    const f = await fixture();
    try {
      const bytes = await readFile(path.join(f.config.vault_path, f.draftPath));
      await writeFile(path.join(f.config.vault_path, '30_Drafts/second.md'), bytes.toString().replace('material.md', 'MATERIAL.md'));
      const discarded = bytes.toString().replace('lifecycle_status: active', 'lifecycle_status: discarded');
      await writeFile(path.join(f.config.vault_path, '30_Drafts/old.md'), discarded);
      const req = await f.request(); req.related_drafts.push({ path: '30_Drafts/second.md', revision: (await readMarkdown(f.config.vault_path, '30_Drafts/second.md')).revision });
      await f.publication.submit(req);
      expect((await readDraft(f.config.vault_path, '30_Drafts/second.md')).lifecycle_status).toBe('discarded');
      expect(await readFile(path.join(f.config.vault_path, '30_Drafts/old.md'), 'utf8')).toBe(discarded);
      await expect(f.publication.submit({ ...req, request_id: randomUUID(), target_path: '40_Knowledge/Second.md' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    } finally { await f.close(); }
  });
  it('recovers partial application after restart, preserving edits to published Knowledge without another model call', async () => {
    const f = await fixture();
    const original = PropertyNative.prototype.run;
    const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this: PropertyNative, ...args) {
      if (args[1] === f.sourcePath && !args[6]) throw new CoreError('IO_ERROR', 'Simulated interruption before archival');
      return original.apply(this, args);
    });
    try {
      const req = await f.request(); await expect(f.publication.submit(req)).rejects.toMatchObject({ code: 'IO_ERROR' });
      expect(f.publication.busy()).toBe(true); expect((await f.publication.forDraft(f.draftPath))?.status).toBe('unfinished');
      expect((await readDraft(f.config.vault_path, f.draftPath)).lifecycle_status).toBe('discarded');
      const formal = path.join(f.config.vault_path, req.target_path); await writeFile(formal, `${await readFile(formal, 'utf8')}\nA later user edit\n`);
      mock.mockRestore(); const recovered = f.create(); await recovered.initialize();
      expect(recovered.busy()).toBe(false); expect((await recovered.forDraft(f.draftPath))?.status).toBe('completed');
      expect(await readFile(formal, 'utf8')).toContain('A later user edit');
      expect(parseMarkdown(f.sourcePath, await readFile(path.join(f.config.vault_path, f.sourcePath))).processing_status).toBe('archived');
      expect((await recovered.submit(req)).reused).toBe(true); expect(f.analyzer.all()).toHaveLength(1);
    } finally { mock.mockRestore(); await f.close(); }
  });
  it('does not recreate a removed committed target during recovery', async () => {
    const f = await fixture(); const original = PropertyNative.prototype.run;
    const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this: PropertyNative, ...args) {
      if (args[1] === f.sourcePath && !args[6]) throw new CoreError('IO_ERROR', 'interrupted'); return original.apply(this, args);
    });
    try {
      const req = await f.request(); await expect(f.publication.submit(req)).rejects.toBeDefined(); mock.mockRestore();
      await unlink(path.join(f.config.vault_path, req.target_path));
      const recovered = f.create(); await recovered.initialize();
      expect(recovered.busy()).toBe(true); expect((await recovered.forDraft(f.draftPath))?.error).toContain('removed or replaced');
      expect((await readdir(path.join(f.config.vault_path, '40_Knowledge'))).includes('Approved.md')).toBe(false);
      expect(parseMarkdown(f.sourcePath, await readFile(path.join(f.config.vault_path, f.sourcePath))).processing_status).toBe('compiled');
    } finally { mock.mockRestore(); await f.close(); }
  });
  it('locks concurrent submissions and refuses publication outside Knowledge', async () => {
    const f = await fixture();
    try {
      const req = await f.request(); await expect(f.publication.submit({ ...req, target_path: '50_Research/paper.md' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
      const first = f.publication.submit(req); const second = f.publication.submit(req);
      await expect(second).rejects.toMatchObject({ code: 'JOB_BUSY' }); expect((await first).status).toBe('completed');
    } finally { await f.close(); }
  });
});
