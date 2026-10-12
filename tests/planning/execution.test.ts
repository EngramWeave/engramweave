import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { integrationFixture } from '../helpers/integration.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';
import { IntegrationExecutor } from '../../packages/core/src/changesets/executor.js';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { getDocument } from '../../packages/core/src/storage/registry.js';
import { randomUUID } from 'node:crypto';

it('applies exact human candidate bytes once, archives only Source stage, consumes workspace and preserves Intent', async () => {
  const f = await integrationFixture();
  try {
    const source = (await readMarkdown(f.config.vault_path, f.sourcePath)).bytes.toString();
    const manifest = (await f.planner.changesets.read(f.id)).manifest; const item = manifest.items[0]!;
    const doc = await f.planner.changesets.candidate(f.id, item.id); const final = doc.content + '\nHuman wording.\n';
    await f.planner.changesets.save({ request_id: crypto.randomUUID(), changeset_id: f.id, item_id: item.id, revision: doc.revision, content: final });
    await f.choose(); const request = await f.approval(); const result = await f.execution.approve(request);
    expect(result.job.status).toBe('succeeded'); expect(await readFile(path.join(f.config.vault_path, item.target), 'utf8')).toBe(final);
    expect((await readMarkdown(f.config.vault_path, f.sourcePath)).bytes.toString()).toBe(source.replace('processing_status: planned', 'processing_status: archived'));
    expect((await readDraft(f.config.vault_path, f.draftPath)).lifecycle_status).toBe('discarded');
    expect(await f.human.context(f.sourcePath, f.draftPath)).toEqual({ selected_draft: null, intent: 'Keep my reviewed understanding.' });
    await expect(access(path.join(f.config.vault_path, '70_ChangeSets', f.id))).rejects.toThrow();
    expect(getDocument(f.db, item.target)?.body_markdown).toContain('Human wording');
    await writeFile(path.join(f.config.vault_path, item.target), final + '\nLater user edit.');
    await writeFile(path.join(f.config.vault_path, f.sourcePath), source.replace('processing_status: planned', 'processing_status: pending'));
    expect((await f.execution.approve(request)).reused).toBe(true);
    await f.planner.initialize(); expect((await readMarkdown(f.config.vault_path, f.sourcePath)).bytes.toString()).toContain('processing_status: pending');
    expect(await readFile(path.join(f.config.vault_path, item.target), 'utf8')).toBe(final + '\nLater user edit.');
    const receipt = JSON.parse(await readFile(path.join(f.config.data_dir, 'integration-executions', `${request.request_id}.json`), 'utf8'));
    expect(receipt.steps).toEqual([]);
  } finally { await f.close(); }
});

it('binds approval to human Current v2 rather than Planner v1, and blocks v4 before any formal write', async () => {
  const f = await integrationFixture(async (snapshot, tools) => {
    await tools.call('read_note', { path: '40_Knowledge/library.md' });
    await tools.call('write_file', { target: '40_Knowledge/library.md', content: `---\nsources: ["[[${snapshot.source.path}]]"]\n---\nPlanner v3.`, reason: 'Update' });
    return { changeset_id: tools.changesetId, summary: 'Ready' };
  }).catch(error => { throw error; });
  try {
    const manifest = (await f.planner.changesets.read(f.id)).manifest; const item = manifest.items[0]!;
    const filename = path.join(f.config.vault_path, item.target); const v2 = (await readFile(filename, 'utf8')) + '\nUser v2.'; await writeFile(filename, v2);
    const doc = await f.planner.changesets.candidate(f.id, item.id); const v3 = doc.content + '\nUser v2.';
    await f.planner.changesets.save({ request_id: crypto.randomUUID(), changeset_id: f.id, item_id: item.id, revision: doc.revision, content: v3 });
    await f.choose(); const request = await f.approval(); await writeFile(filename, v2 + '\nUser v4.');
    await expect(f.execution.approve(request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect((await f.execution.lookup(request.request_id)).job).toBeNull(); expect(await readFile(filename, 'utf8')).toBe(v2 + '\nUser v4.');
    const refreshed = await f.approval(); expect((await f.execution.approve(refreshed)).job.status).toBe('succeeded'); expect(await readFile(filename, 'utf8')).toBe(v3);
  } finally { await f.close(); }
});

it('resumes archive interruption without overwriting already-applied edits, preserves later Draft body edits and blocks cancellation', async () => {
  const f = await integrationFixture(); const original = PropertyNative.prototype.run;
  const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this: PropertyNative, ...args) {
    if (args[1] === f.sourcePath && !args[6] && !args[10]) throw new CoreError('IO_ERROR', 'Injected archive interruption'); return original.apply(this, args);
  });
  try {
    await f.choose(); const request = await f.approval(); expect((await f.execution.approve(request)).job.status).toBe('failed');
    expect(f.execution.busy()).toBe(true); await expect(f.planner.cancelChangeSet(f.id)).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
    const target = '40_Knowledge/Integrated.md'; const before = await readFile(path.join(f.config.vault_path, target), 'utf8'); await writeFile(path.join(f.config.vault_path, target), before + '\nLater formal edit.');
    const draft = (await readMarkdown(f.config.vault_path, f.draftPath)).bytes.toString() + '\nLater Draft edit.'; await writeFile(path.join(f.config.vault_path, f.draftPath), draft);
    mock.mockRestore(); f.db.prepare('DELETE FROM integration_jobs').run();
    const recovery = new IntegrationExecutor(f.config, f.db, f.planner.changesets, f.human, () => false, (source, id) => f.human.revoke(source, null, id));
    await recovery.initialize(); expect(recovery.get(request.request_id)?.status).toBe('succeeded');
    expect(await readFile(path.join(f.config.vault_path, target), 'utf8')).toBe(before + '\nLater formal edit.');
    expect((await readMarkdown(f.config.vault_path, f.draftPath)).bytes.toString()).toContain('Later Draft edit.'); expect((await recovery.approve(request)).reused).toBe(true);
  } finally { mock.mockRestore(); await f.close(); }
});
it('explicitly cancels an unapproved plan to reviewed and replans from the current Draft without losing Intent', async () => {
  const f=await integrationFixture(async(snapshot,tools)=>{
    await tools.call('write_file',{target:'40_Knowledge/Integrated.md',content:`---\nsources: ["[[${snapshot.source.path}]]"]\n---\n${snapshot.draft.content.split('---')[2]}`,reason:'Current reviewed wording'});
    return{changeset_id:tools.changesetId,summary:'Ready'};
  });
  try{
    await writeFile(path.join(f.config.vault_path,f.draftPath),(await readMarkdown(f.config.vault_path,f.draftPath)).bytes.toString()+'\nLater reviewed wording.');
    expect((await f.planner.changesets.list()).map(item=>item.id)).toEqual([f.id]);
    await f.planner.cancelChangeSet(f.id);expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes.toString()).toContain('processing_status: reviewed');
    expect(await f.human.context(f.sourcePath,f.draftPath)).toEqual({selected_draft:f.draftPath,intent:'Keep my reviewed understanding.'});
    const submitted=await f.planner.submit({request_id:randomUUID(),source_path:f.sourcePath});await f.planner.wait();const next=f.planner.get(submitted.job.id)!;
    expect(next.status).toBe('succeeded');expect(next.changeset_id).not.toBe(f.id);
    const manifest=(await f.planner.changesets.read(next.changeset_id!)).manifest;expect((await f.planner.changesets.candidate(manifest.id,manifest.items[0]!.id)).content).toContain('Later reviewed wording.');
  }finally{await f.close();}
});
it('retires its exact interrupted staging file and publishes complete approved content without exposing a partial formal note', async()=>{
  const f=await integrationFixture();let staging='';
  const mock=vi.spyOn(PropertyNative.prototype,'createFormal').mockImplementation(async(vault,relative,_bytes,_revision,id)=>{
    staging=path.join(vault,path.posix.dirname(relative),`.engramweave-capture-${id}.tmp`);await writeFile(staging,'Interrupted partial staging bytes');throw new CoreError('IO_ERROR','Interrupted before atomic publication');
  });
  try{
    await f.choose();const request=await f.approval();expect((await f.execution.approve(request)).job.status).toBe('failed');
    await expect(access(path.join(f.config.vault_path,'40_Knowledge/Integrated.md'))).rejects.toThrow();await access(staging);
    mock.mockRestore();expect((await f.execution.approve(request)).job.status).toBe('succeeded');await expect(access(staging)).rejects.toThrow();
    expect(await readFile(path.join(f.config.vault_path,'40_Knowledge/Integrated.md'),'utf8')).toContain('Reviewed knowledge.');
  }finally{mock.mockRestore();await f.close();}
});
