import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { CompilerJobs } from '../../packages/core/src/jobs/compiler.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { ProcessingRounds } from '../../packages/core/src/jobs/processing-rounds.js';
import { ProcessingSettingsStore } from '../../packages/core/src/processing/settings.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';

async function fixture(failReview = false, beforeCompiler?: (vault: string, signal: AbortSignal) => Promise<void>) {
  const calls: string[] = [];
  const f = await analyzerFixture(async task => { calls.push(task); if (failReview && task === 'review') throw new CoreError('INVALID_MODEL_OUTPUT','bad Review'); return emptyAnalysis(task); });
  const compiler = new CompilerJobs(f.db,f.config,() => false, async (_settings,_prompt,signal) => { calls.push('compiler'); await beforeCompiler?.(f.config.vault_path,signal); return { title: 'Compiled', body: 'New body' }; });
  await compiler.initialize(); await compiler.settings.save({ ...defaultSettings, route: 'api', endpoint: 'http://127.0.0.1:8094/v1', model: 'fixture' });
  let semantic = 0; const scans = new ScanJobs(f.db,f.config.vault_path,() => false, async () => { semantic++; });
  const settings = new ProcessingSettingsStore(f.config.data_dir); await settings.initialize();
  const rounds = new ProcessingRounds(f.db,f.config,scans,compiler,f.analyzer,settings,() => false); rounds.initialize();
  return { ...f, calls, compiler, scans, rounds, semantic: () => semantic, async close() { await rounds.close(); await compiler.close(); await scans.close(); await f.close(); } };
}
describe('Core-owned complete processing rounds', () => {
  it('registers new Capture without Refresh, processes only eligible pending Sources, and replays one round', async () => {
    const f = await fixture();
    try {
      await writeDocument(f.config.vault_path,'20_Sources/new.md',manualSource('Captured without prior scan'));
      for (const stage of ['compiled','reviewed','planned','archived']) await writeDocument(f.config.vault_path,`20_Sources/${stage}.md`,manualSource('ineligible',`processing_status: ${stage}\n`));
      await writeDocument(f.config.vault_path,'20_Sources/discarded.md',manualSource('discarded','processing_status: pending\nlifecycle_status: discarded\n'));
      const request = { request_id: randomUUID(), mode: 'pending' as const }; await f.rounds.submit(request); await f.rounds.wait();
      const round = f.rounds.get(request.request_id)!; expect(round.status).toBe('succeeded'); expect(round.items.find(i => i.source_path === '20_Sources/new.md')).toMatchObject({status:'succeeded',phase:'finished'});expect(round.items.find(i => i.source_path === '20_Sources/reviewed.md')).toMatchObject({status:'skipped',error:{message:expect.stringContaining('Planner')}});
      expect(f.calls).toEqual(['compiler','review','relation']); expect(f.semantic()).toBe(0); expect(round.items[0]?.draft_path).toMatch(/^30_Drafts\//);
      expect(await f.rounds.submit(request)).toMatchObject({ reused: true }); expect(f.calls).toHaveLength(3);
      await f.rounds.submit({ request_id: randomUUID(), mode: 'pending' }); await f.rounds.wait(); expect(f.calls).toHaveLength(3);
      expect(await readFile(path.join(f.config.vault_path,'20_Sources/new.md'),'utf8')).toContain('processing_status: compiled');
    } finally { await f.close(); }
  });
  it('reports queued edits, Discard and missing files per item while finishing unaffected Sources', async () => {
    let first = true; const f = await fixture(false,async vault => {
      if (!first) return; first = false;
      await writeFile(path.join(vault,'20_Sources/b.md'),manualSource('changed by user','processing_status: pending\n'));
      await writeFile(path.join(vault,'20_Sources/c.md'),manualSource('discarded','processing_status: pending\nlifecycle_status: discarded\n'));
      await unlink(path.join(vault,'20_Sources/d.md'));
    });
    try {
      for (const name of ['a','b','c','d','e']) await writeDocument(f.config.vault_path,`20_Sources/${name}.md`,manualSource('initial','processing_status: pending\n'));
      const id = randomUUID();await f.rounds.submit({request_id:id,mode:'pending'});await f.rounds.wait();const round=f.rounds.get(id)!;
      expect(round.items.map(i=>i.status)).toEqual(['succeeded','failed','failed','failed','succeeded']);expect(f.calls).toEqual(['compiler','review','relation','compiler','review','relation']);
      expect(round.items[1]?.error?.code).toBe('SOURCE_CHANGED');expect(await readFile(path.join(f.config.vault_path,'20_Sources/b.md'),'utf8')).toContain('changed by user');
    } finally {await f.close();}
  });
  it('cancels the current model and interrupts remaining items without running them', async () => {
    let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const f=await fixture(false,async (_vault,signal)=>new Promise<void>((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));
    try {
      for (const name of ['a','b']) await writeDocument(f.config.vault_path,`20_Sources/${name}.md`,manualSource('initial'));
      const id=randomUUID();await f.rounds.submit({request_id:id,mode:'pending'});await ready;await expect(f.rounds.submit({request_id:randomUUID(),mode:'pending'})).rejects.toMatchObject({code:'JOB_BUSY'});await f.rounds.cancel(id);
      expect(f.rounds.get(id)).toMatchObject({status:'interrupted',items:[{status:'interrupted'},{status:'interrupted'}]});expect(f.calls).toEqual(['compiler']);
    } finally {await f.close();}
  });
  it('retains a successful Draft after failed analysis and reanalyzes its explicit version without Compiler', async () => {
    const f = await fixture(true);
    try {
      await writeDocument(f.config.vault_path,'20_Sources/new.md',manualSource('Text'));
      const id = randomUUID(); await f.rounds.submit({ request_id: id, mode: 'pending' }); await f.rounds.wait();
      const first = f.rounds.get(id)!; expect(first.status).toBe('failed'); expect(f.calls).toEqual(['compiler','review','relation']);
      const item = first.items[0]!; const draft = await readMarkdown(f.config.vault_path,item.draft_path!); const source = await readMarkdown(f.config.vault_path,item.source_path);
      const next = randomUUID(); await f.rounds.submit({ request_id: next, mode: 'analyze', items: [{ source_path: item.source_path, source_revision: source.revision, draft_path: item.draft_path!, draft_revision: draft.revision, task: 'relation' }] }); await f.rounds.wait();
      expect(f.rounds.get(next)?.status).toBe('succeeded'); expect(f.calls).toEqual(['compiler','review','relation','relation']); expect((await readMarkdown(f.config.vault_path,item.draft_path!)).bytes).toEqual(draft.bytes);
      expect((await readMarkdown(f.config.vault_path,item.source_path)).bytes.toString()).toContain('processing_status: compiled');
    } finally { await f.close(); }
  });
  it('marks interrupted queued work without re-executing models on initialization', async () => {
    const f = await fixture();
    try {
      const request = { request_id: randomUUID(), mode: 'pending' }; const round = { id: request.request_id, mode: 'pending', trigger: 'manual', status: 'running', created_at: new Date().toISOString(), max_retries: 2, items: [{ status: 'pending', source_path: '20_Sources/new.md' }] };
      f.db.prepare('INSERT INTO processing_rounds VALUES(?,?,?)').run(request.request_id,JSON.stringify(request),JSON.stringify(round)); f.rounds.initialize();
      expect(f.rounds.get(request.request_id)).toMatchObject({ status: 'interrupted', items: [{ status: 'interrupted' }] }); expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });
  it('preserves the existing unarchived read-only Analyzer boundary without changing a planned Source stage', async () => {
    const f=await fixture();
    try {
      await writeDocument(f.config.vault_path,f.sourcePath,manualSource('Text','processing_status: planned\n'));const source=await readMarkdown(f.config.vault_path,f.sourcePath),draft=await readMarkdown(f.config.vault_path,f.draftPath);const id=randomUUID();
      await f.rounds.submit({request_id:id,mode:'analyze',items:[{source_path:f.sourcePath,source_revision:source.revision,draft_path:f.draftPath,draft_revision:draft.revision,task:'review'}]});await f.rounds.wait();expect(f.rounds.get(id)?.status).toBe('succeeded');expect(f.calls).toEqual(['review']);expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes).toEqual(source.bytes);
    }finally{await f.close();}
  });
});
