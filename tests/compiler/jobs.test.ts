import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilerFixture, sourceText, waitCompiler } from '../helpers/compiler.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { listDrafts } from '../../packages/core/src/drafts/files.js';
import { CompilerJobs } from '../../packages/core/src/jobs/compiler.js';
import { publishFile } from '../../packages/core/src/files/publication.js';
import { searchDocuments } from '../../packages/core/src/search/query.js';

describe('Compiler jobs and multiple Drafts', () => {
  it('publishes another Draft without altering earlier user edits and replays a request without another call', async () => {
    let calls = 0; const inputs: any[] = [];
    const fixture = await compilerFixture(async (settings, prompt) => { calls++; inputs.push({ settings, input: JSON.parse(prompt) }); return { title: 'Compiled understanding', body: 'Condition A and personal understanding are preserved.' }; });
    try {
      await mkdir(path.join(fixture.config.vault_path, '30_Drafts'));
      const earlier = '---\ntype: draft\ntitle: My edits\nlifecycle_status: active\nsources:\n  - "[[20_Sources/selected.md]]"\n---\n\nMy manually edited body.\n';
      await writeFile(path.join(fixture.config.vault_path, '30_Drafts/earlier.md'), earlier);
      const input = { path: fixture.sourcePath, revision: fixture.revision, request_id: randomUUID() };
      const submitted = await fixture.compiler.submit(input);
      expect(submitted.reused).toBe(false);
      const job = await waitCompiler(fixture.compiler, input.request_id);
      expect(job.status).toBe('succeeded');
      expect((await fixture.compiler.submit(input)).reused).toBe(true);
      expect(calls).toBe(1);
      expect(inputs[0].input).toEqual({ submitted_content: '\n# Selected material\n\nOnly this passage is submitted. The effect holds under condition A.\n', annotation: 'I understand that memory is reconstructed.', source_title: 'Selected material', original_locator: 'zotero://select/library/items/TEST123' });
      expect(await readFile(path.join(fixture.config.vault_path, '30_Drafts/earlier.md'), 'utf8')).toBe(earlier);
      expect(await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8')).toBe(sourceText.replace('processing_status: pending', 'processing_status: compiled'));
      const drafts = await listDrafts(fixture.config.vault_path, fixture.sourcePath);
      expect(drafts.items).toHaveLength(2);
      expect(drafts.items.every(item => item.lifecycle_status === 'active')).toBe(true);
      await expect(fixture.compiler.submit({ ...input, request_id: randomUUID(), revision: (await readMarkdown(fixture.config.vault_path, fixture.sourcePath)).revision })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
      await expect(fixture.compiler.submit({ ...input, path: '20_Sources/other.md' })).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
    } finally { await fixture.close(); }
  }, 60_000);
  it('rejects changed Source content after model execution and does not publish or advance it', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const fixture = await compilerFixture(async () => { await ready; return { title: 'Old input', body: 'Old input output' }; });
    try {
      const request_id = randomUUID();
      await fixture.compiler.submit({ path: fixture.sourcePath, revision: fixture.revision, request_id });
      const modified = sourceText + '\nNew user content\n';
      await writeFile(path.join(fixture.config.vault_path, fixture.sourcePath), modified);
      release();
      const job = await waitCompiler(fixture.compiler, request_id);
      expect(job.status).toBe('failed'); expect(job.error?.code).toBe('SOURCE_CHANGED');
      expect(await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8')).toBe(modified);
      expect((await listDrafts(fixture.config.vault_path, fixture.sourcePath)).items).toHaveLength(0);
    } finally { release(); await fixture.close(); }
  }, 60_000);
  it('recovers a persisted model result after restart without calling the model again', async () => {
    const fixture = await compilerFixture(async () => { throw new Error('model must not run'); });
    try {
      const id = randomUUID();
      await fixture.compiler.publisher.prepare(id, fixture.sourcePath, fixture.revision, { title: 'Saved result', body: 'Persisted body before publication.' });
      await fixture.compiler.close();
      const recovered = new CompilerJobs(fixture.db, fixture.config, () => false, async () => { throw new Error('must not call'); });
      await recovered.initialize();
      expect(recovered.get(id)?.status).toBe('succeeded');
      expect((await listDrafts(fixture.config.vault_path, fixture.sourcePath)).items).toHaveLength(1);
      expect((await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8'))).toContain('processing_status: compiled');
      await recovered.initialize();
      expect((await listDrafts(fixture.config.vault_path, fixture.sourcePath)).items).toHaveLength(1);
      await recovered.close();
    } finally { await fixture.close(); }
  }, 60_000);
  it.each(['draft_published', 'stage_written'])('recovers %s without duplicating a Draft or losing a later edit', async point => {
    const fixture = await compilerFixture(async () => { throw new Error('must not execute'); });
    try {
      const id = randomUUID();
      const record = await fixture.compiler.publisher.prepare(id, fixture.sourcePath, fixture.revision, { title: 'Recoverable', body: 'Saved model result.' }, { route: 'api', model: 'recorded-model' });
      if (point === 'draft_published') {
        await mkdir(path.join(fixture.config.vault_path, '30_Drafts'));
        expect(await publishFile(fixture.config.vault_path, record.draft, Buffer.from(record.draft_bytes, 'base64'))).toBe(true);
      } else {
        await fixture.compiler.publisher.finish(record);
        await writeFile(path.join(fixture.config.vault_path, record.draft), Buffer.from(record.draft_bytes, 'base64').toString() + '\nLater user edit\n');
      }
      const recovered = new CompilerJobs(fixture.db, fixture.config, () => false, async () => { throw new Error('must not execute'); });
      await recovered.initialize();
      expect(recovered.get(id)).toMatchObject({ status: 'succeeded', route: 'api', model: 'recorded-model' });
      const drafts = await listDrafts(fixture.config.vault_path, fixture.sourcePath);
      expect(drafts.items).toHaveLength(1);
      if (point === 'stage_written') expect(drafts.items[0]?.body).toContain('Later user edit');
      expect(await fixture.compiler.publisher.pending()).toEqual([]);
      await recovered.close();
    } finally { await fixture.close(); }
  }, 60_000);
  it('refuses lifecycle, stage, content and stale-input violations before any model call', async () => {
    let calls = 0;
    const fixture = await compilerFixture(async () => { calls++; return { title: 'Wrong', body: 'must not run' }; });
    try {
      for (const text of [sourceText.replace('pending # stage', 'compiled # stage'), sourceText.replace('pending # stage', 'pending # stage\nlifecycle_status: discarded'), sourceText.replace('source_type: paper', 'source_type: paper\nasset: zotero://select/library/items/TEST123')]) {
        await writeFile(path.join(fixture.config.vault_path, fixture.sourcePath), text);
        const file = await readMarkdown(fixture.config.vault_path, fixture.sourcePath);
        await expect(fixture.compiler.submit({ path: fixture.sourcePath, revision: file.revision, request_id: randomUUID() })).rejects.toThrow();
      }
      await expect(fixture.compiler.submit({ path: fixture.sourcePath, revision: fixture.revision, request_id: randomUUID() })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      expect(calls).toBe(0);
    } finally { await fixture.close(); }
  }, 60_000);
  it('publishes fresh cached content with its new revision and refuses a retained request after runtime history loss', async () => {
    let calls = 0;
    const fixture = await compilerFixture(async () => { calls++; return { title: 'Fresh content', body: 'A fresh candidate' }; });
    try {
      const changed = sourceText.replace('memory is reconstructed.', 'memory is reconstructed. freshannotationword') + '\npublicationfreshword\n';
      await writeFile(path.join(fixture.config.vault_path, fixture.sourcePath), changed);
      const current = await readMarkdown(fixture.config.vault_path, fixture.sourcePath);
      const input = { path: fixture.sourcePath, revision: current.revision, request_id: randomUUID() };
      await fixture.compiler.submit(input);
      expect((await waitCompiler(fixture.compiler, input.request_id)).status).toBe('succeeded');
      expect(searchDocuments(fixture.db, { q: 'publicationfreshword', scope: 'sources' }).total).toBe(1);
      expect(searchDocuments(fixture.db, { q: 'freshannotationword', scope: 'sources', fields: 'annotation' }).total).toBe(1);
      fixture.db.prepare('DELETE FROM compiler_jobs').run();
      await writeFile(path.join(fixture.config.vault_path, fixture.sourcePath), changed);
      await expect(fixture.compiler.submit(input)).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
      expect(calls).toBe(1);
    } finally { await fixture.close(); }
  }, 60_000);
  it('preserves a moved completed Draft during recovery without creating another candidate', async () => {
    const fixture = await compilerFixture(async () => { throw new Error('must not execute'); });
    try {
      const id = randomUUID();
      const record = await fixture.compiler.publisher.prepare(id, fixture.sourcePath, fixture.revision, { title: 'Moved candidate', body: 'User-owned candidate' });
      await fixture.compiler.publisher.finish(record);
      await rename(path.join(fixture.config.vault_path, record.draft), path.join(fixture.config.vault_path, '30_Drafts/renamed.md'));
      const recovered = new CompilerJobs(fixture.db, fixture.config, () => false, async () => { throw new Error('must not execute'); });
      await recovered.initialize();
      expect(recovered.get(id)).toMatchObject({ status: 'failed', error: { code: 'COMPILATION_RECOVERY_CONFLICT' } });
      expect((await listDrafts(fixture.config.vault_path, fixture.sourcePath)).items.map(item => item.path)).toEqual(['30_Drafts/renamed.md']);
      expect(await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8')).toContain('processing_status: compiled');
      await recovered.close();
    } finally { await fixture.close(); }
  }, 60_000);
});
