import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { compilerFixture } from '../helpers/compiler.js';
import { SourceBatches } from '../../packages/core/src/jobs/source-batches.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { sourceRelations } from '../../packages/core/src/storage/source-relations.js';

async function complete(batch: SourceBatches, id: string) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    const value = batch.get(id); if (value.status !== 'running') return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Cleanup did not complete');
}
const draft = (title: string, life = 'active') => `---\ntype: draft\ntitle: ${title}\nsources: ["[[20_Sources/selected.md]]"]\nlifecycle_status: ${life}\n---\nUser text ${title}.\n`;
it('discards only chosen active Drafts, retains Source bytes and hides old discarded backlinks', async () => {
  const fixture = await compilerFixture(async () => ({ title: 'Unused', body: 'No model call' }));
  const batch = new SourceBatches(fixture.config, fixture.db, fixture.compiler, () => false);
  try {
    const root = fixture.config.vault_path;
    await mkdir(path.join(root, '30_Drafts'));
    for (const [name, life] of [['one','active'], ['two','active'], ['old','discarded']]) await writeFile(path.join(root, `30_Drafts/${name}.md`), draft(name!, life));
    const preview = await batch.preview(fixture.sourcePath);
    expect(preview.drafts.map(item => item.path)).toEqual(['30_Drafts/one.md', '30_Drafts/two.md']);
    const before = await readFile(path.join(root, fixture.sourcePath));
    const input = { id: randomUUID(), action: 'discard_drafts' as const, items: [{ ...preview.source, request_id: randomUUID(), related: [preview.drafts[0]!] }] };
    await batch.submit(input); expect((await complete(batch, input.id)).items[0]?.status).toBe('succeeded');
    expect(await readFile(path.join(root, fixture.sourcePath))).toEqual(before);
    expect((await readDraft(root, '30_Drafts/one.md')).lifecycle_status).toBe('discarded');
    expect((await readDraft(root, '30_Drafts/two.md')).lifecycle_status).toBe('active');
    const next = await batch.preview(fixture.sourcePath);
    expect(next.drafts.map(item => item.path)).toEqual(['30_Drafts/two.md']);
    const discard = { id: randomUUID(), action: 'discard' as const, items: [{ ...next.source, request_id: randomUUID(), related: next.drafts }] };
    await batch.submit(discard); expect((await complete(batch, discard.id)).items[0]?.status).toBe('succeeded');
    expect((await batch.preview(fixture.sourcePath)).drafts).toEqual([]);
  } finally { await batch.close(); await fixture.close(); }
});
it('physically deletes only discarded exact-revision Source Records, with explicit formal-reference override and no Draft deletion', async () => {
  const fixture = await compilerFixture(async () => ({ title: 'Unused', body: 'No model call' }));
  const batch = new SourceBatches(fixture.config, fixture.db, fixture.compiler, () => false);
  try {
    const root = fixture.config.vault_path;
    await mkdir(path.join(root, '30_Drafts'));
    await writeFile(path.join(root, '30_Drafts/old.md'), draft('old', 'discarded'));
    const active = { id: randomUUID(), action: 'delete' as const, items: [{ path: fixture.sourcePath, revision: fixture.revision, request_id: randomUUID() }] };
    await batch.submit(active); expect((await complete(batch, active.id)).items[0]?.status).toBe('skipped');
    await mkdir(path.join(root, '40_Knowledge'));
    const formal = '---\nsources: ["[[../20_Sources/selected#Section|Material]]"]\nlifecycle_status: active\n---\nFormal text.\n';
    await writeFile(path.join(root, '40_Knowledge/formal.md'), formal);
    const scan = new ScanJobs(fixture.db, root); scan.submit('refresh'); await scan.close();
    const preview = await batch.preview(fixture.sourcePath);
    const discard = { id: randomUUID(), action: 'discard' as const, items: [{ ...preview.source, request_id: randomUUID(), related: [] }] };
    await batch.submit(discard); expect((await complete(batch, discard.id)).items[0]?.status).toBe('succeeded');
    const revision = (await readMarkdown(root, fixture.sourcePath)).revision;
    const remove = { id: randomUUID(), action: 'delete' as const, items: [{ path: fixture.sourcePath, revision, request_id: randomUUID() }] };
    await batch.submit(remove); expect((await complete(batch, remove.id)).items[0]?.error?.message).toContain('Active formal');
    const stale = { ...remove, id: randomUUID(), items: [{ ...remove.items[0]!, revision: fixture.revision, allow_referenced: true }] };
    await batch.submit(stale); expect((await complete(batch, stale.id)).items[0]?.status).toBe('skipped');
    const missingApproval = { ...remove, id: randomUUID(), items: [{ ...remove.items[0]!, allow_referenced: true }] };
    await batch.submit(missingApproval); expect((await complete(batch, missingApproval.id)).items[0]?.status).toBe('skipped');
    const confirmed = { ...remove, id: randomUUID(), items: [{ ...remove.items[0]!, allow_referenced: true, reference_revisions: (await batch.preview(fixture.sourcePath)).references }] };
    await batch.submit(confirmed); expect((await complete(batch, confirmed.id)).items[0]?.status).toBe('succeeded');
    await expect(readFile(path.join(root, fixture.sourcePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, '40_Knowledge/formal.md'), 'utf8')).toBe(formal);
    expect(await readFile(path.join(root, '30_Drafts/old.md'), 'utf8')).toBe(draft('old', 'discarded'));
    expect(fixture.db.prepare('SELECT * FROM documents WHERE path=?').get(fixture.sourcePath)).toBeUndefined();
    expect((await batch.submit(confirmed)).items[0]?.status).toBe('succeeded');
  } finally { await batch.close(); await fixture.close(); }
});
it('refuses physical deletion of a hardlinked Source without changing either filesystem name', async () => {
  const fixture = await compilerFixture(async () => ({ title: 'Unused', body: 'No model call' }));
  const batch = new SourceBatches(fixture.config, fixture.db, fixture.compiler, () => false);
  try {
    const filename = path.join(fixture.config.vault_path, fixture.sourcePath);
    const text = (await readFile(filename, 'utf8')).replace('lifecycle_status: active', 'lifecycle_status: discarded');
    await writeFile(filename, text);
    const alias = path.join(fixture.config.vault_path, '20_Sources/alias.md'); await link(filename, alias);
    const input = { id: randomUUID(), action: 'delete' as const, items: [{ path: fixture.sourcePath, revision: (await readMarkdown(fixture.config.vault_path, fixture.sourcePath)).revision, request_id: randomUUID() }] };
    await batch.submit(input); expect((await complete(batch, input.id)).items[0]?.status).toBe('failed');
    expect(await readFile(filename, 'utf8')).toBe(text); expect(await readFile(alias, 'utf8')).toBe(text);
  } finally { await batch.close(); await fixture.close(); }
});
it('coalesces concurrent backlink rebuilds and queries SQLite without rescanning Drafts for every Source', async () => {
  const fixture = await compilerFixture(async () => ({ title: 'Unused', body: 'No model call' }));
  try {
    await mkdir(path.join(fixture.config.vault_path, '30_Drafts'));
    await writeFile(path.join(fixture.config.vault_path, '30_Drafts/one.md'), draft('one'));
    const index = sourceRelations(fixture.db, fixture.config.vault_path);
    await Promise.all(Array.from({ length: 8 }, () => index.refresh()));
    expect(index.related(fixture.sourcePath).drafts).toHaveLength(1);
    await writeFile(path.join(fixture.config.vault_path, '30_Drafts/two.md'), draft('two'));
    await Promise.all(Array.from({ length: 8 }, () => index.refresh()));
    expect(index.related(fixture.sourcePath).drafts).toHaveLength(1);
    await index.refresh(true); expect(index.related(fixture.sourcePath).drafts).toHaveLength(2);
  } finally { await fixture.close(); }
});

it('reconciles changed metadata, Draft lifecycle, rename and deletion without retaining old backlinks', async () => {
  const fixture = await compilerFixture(async () => ({ title: 'Unused', body: 'No model call' }));
  try {
    const root = fixture.config.vault_path;
    await mkdir(path.join(root, '30_Drafts'));
    const file = path.join(root, '30_Drafts/one.md');
    await writeFile(file, draft('Original'));
    const index = sourceRelations(fixture.db, root);
    await index.refresh(true); expect(index.related(fixture.sourcePath).drafts[0]?.title).toBe('Original');
    const other = '20_Sources/other.md';
    const text = draft('Changed').replace(fixture.sourcePath, other) + 'User edit.\n';
    await writeFile(file, text); await index.refresh(true);
    expect(index.targets(fixture.sourcePath).drafts).toEqual([]);
    expect(index.related(other).drafts[0]).toMatchObject({ title: 'Changed', body: 'User text Changed.\nUser edit.\n' });
    await writeFile(file, text.replace('lifecycle_status: active', 'lifecycle_status: discarded'));
    await index.refresh(true); expect(index.targets(other).drafts).toEqual([]);
    await writeFile(file, text); await rename(file, path.join(root, '30_Drafts/renamed.md'));
    await index.refresh(true); expect(index.targets(other).drafts[0]?.path).toBe('30_Drafts/renamed.md');
    await unlink(path.join(root, '30_Drafts/renamed.md')); await index.refresh(true);
    expect(index.targets(other).drafts).toEqual([]);
  } finally { await fixture.close(); }
});

it('publishes durable completion before accepting an immediately following batch', async () => {
  const fixture = await compilerFixture(async () => ({ title: 'Unused', body: 'No model call' }));
  const batches = new SourceBatches(fixture.config, fixture.db, fixture.compiler, () => false);
  try {
    for (let index = 0; index < 5; index++) {
      const input = { id: randomUUID(), action: 'restore' as const, items: [{ path: fixture.sourcePath, revision: fixture.revision, request_id: randomUUID() }] };
      await batches.submit(input);
      while (batches.get(input.id).status === 'running') await new Promise<void>(resolve => setImmediate(resolve));
      const saved = JSON.parse(await readFile(path.join(fixture.config.data_dir, 'source-batch.json'), 'utf8'));
      expect(saved.input.id).toBe(input.id); expect(saved.result.status).toBe('completed');
      expect(saved.result.items[0].status).toBe('succeeded');
    }
  } finally { await batches.close(); await fixture.close(); }
});
