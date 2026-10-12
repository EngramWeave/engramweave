import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, link } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeSets } from '../../packages/core/src/changesets/store.js';
import { readVaultFile } from '../../packages/core/src/files/read.js';
import { listAllDrafts } from '../../packages/core/src/drafts/files.js';
import { isolatedRuntime } from '../helpers/runtime.js';

const revision = 'a'.repeat(64);
describe('ChangeSet workspace persistence and authority', () => {
  it('preserves formal files, rejects stale saves and retains candidate revisions across restart', async () => {
    const runtime = await isolatedRuntime();
    try {
      const target = '40_Knowledge/method.md'; const source = '20_Sources/paper.md';
      await mkdir(path.join(runtime.config.vault_path, '40_Knowledge'));
      await writeFile(path.join(runtime.config.vault_path, target), '# Current\nUser edit.');
      const store = new ChangeSets(runtime.config);
      const manifest = await store.create({ source_path: source, source_revision: revision, draft_path: '30_Drafts/selected.md', draft_revision: revision, intent: 'Integrate', model: 'test' });
      const before = await readVaultFile(runtime.config.vault_path, target);
      const item = await store.propose(manifest.id, { kind: 'write', target, before_revision: before.revision, reason: 'Retain a useful method', evidence: [], requires_domain_approval: false }, `---\nsources: ["[[${source}]]"]\n---\n# Candidate`);
      await store.publish(manifest.id);
      const view = await store.candidate(manifest.id, item.id);
      expect(view.current).toContain('User edit.');
      const save = { request_id: randomUUID(), changeset_id: manifest.id, item_id: item.id, revision: view.revision, content: '# Human candidate\n[[20_Sources/paper.md]]' };
      const saved = await store.save(save);
      expect(await store.save(save)).toEqual(saved);
      await expect(store.save({ ...save, request_id: randomUUID(), content: 'Overwrite later edit' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      expect((await new ChangeSets(runtime.config).candidate(manifest.id, item.id)).content).toBe(save.content);
      expect(await readFile(path.join(runtime.config.vault_path, target), 'utf8')).toBe('# Current\nUser edit.');
      expect((await listAllDrafts(runtime.config.vault_path)).items).toHaveLength(0);
      await expect(store.propose(manifest.id, { ...item, target }, 'Agent overwrite')).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
      await store.cancel(manifest.id);
      expect(await store.list()).toEqual([]);
      expect(await readFile(path.join(runtime.config.vault_path, target), 'utf8')).toContain('User edit.');
    } finally { await runtime.cleanup(); }
  });
  it('refuses escapes, linked candidates and a ready plan without final content', async () => {
    const runtime = await isolatedRuntime();
    try {
      const store = new ChangeSets(runtime.config);
      const manifest = await store.create({ source_path: '20_Sources/a.md', source_revision: revision, draft_path: '30_Drafts/a.md', draft_revision: revision, intent: '', model: 'test' });
      const base = { kind: 'write' as const, before_revision: null, reason: 'Useful', evidence: [], requires_domain_approval: false };
      for (const target of ['40_Knowledge/../a.md', '20_Sources/a.md', '70_ChangeSets/a.md', '40_Knowledge/CON.md']) {
        await expect(store.propose(manifest.id, { ...base, target }, 'Escape')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
      }
      await expect(store.publish(manifest.id)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
      const project=await store.propose(manifest.id,{...base,target:'60_Projects/project.md'},'---\nsources: ["[[20_Sources/a.md]]"]\n---\n# Project');
      await store.publish(manifest.id);expect((await store.candidate(manifest.id,project.id)).current).toBeNull();
      const pending=await store.create({source_path:'20_Sources/a.md',source_revision:revision,draft_path:'30_Drafts/a.md',draft_revision:revision,intent:'',model:'test'});
      const item = await store.propose(pending.id, { ...base, target: '50_Research/a.md' }, '# Research\n[[20_Sources/a.md]]');
      await expect(store.publish(pending.id)).rejects.toMatchObject({code:'INVALID_MODEL_OUTPUT'});
      await link(path.join(runtime.config.vault_path, item.candidate_path!), path.join(runtime.root, 'alias.md'));
      await expect(store.candidate(pending.id, item.id)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
    } finally { await runtime.cleanup(); }
  });
});
