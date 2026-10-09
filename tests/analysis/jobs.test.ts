import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture, analysisProfile, emptyAnalysis } from '../helpers/analyzer.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { AnalyzerJobs } from '../../packages/core/src/jobs/analyzer.js';

describe('Analyzer rounds, reuse and recovery', () => {
  it.each(['input','output','none'] as const)('uses current-round %s reuse and persists independent results without changing files', async reuse => {
    const observed: { task: string; input: Record<string,unknown> }[] = [];
    const f = await analyzerFixture(async (task, _settings, prompt, _signal, _instructions, tools) => {
      observed.push({ task, input: JSON.parse(prompt) });
      if (task === 'review') await tools.call('read_input', {});
      return emptyAnalysis(task);
    });
    try {
      await f.analyzer.settings.save({ default_profile: 'knowledge', profiles: [analysisProfile(reuse)] });
      const before = await Promise.all([f.sourcePath, f.draftPath, f.libraryPath].map(p => readFile(path.join(f.config.vault_path, p))));
      const request = f.request(); await f.analyzer.submit(request); await f.analyzer.wait();
      expect(f.analyzer.get(request.request_id)?.status).toBe('succeeded'); expect(observed.map(o => o.task)).toEqual(['review','relation']);
      expect(observed[1]!.input.source).toEqual(observed[0]!.input.source); expect(observed[1]!.input.draft).toEqual(observed[0]!.input.draft);
      expect(Object.hasOwn(observed[1]!.input, 'review_reference')).toBe(reuse === 'output');
      const result = await f.analyzer.result(request.request_id); expect(result.stale).toBe(false);
      expect((result.record.review as { observations: unknown[] }).observations).toHaveLength(1);
      expect(await Promise.all([f.sourcePath, f.draftPath, f.libraryPath].map(p => readFile(path.join(f.config.vault_path, p))))).toEqual(before);
      expect((await f.analyzer.submit(request)).reused).toBe(true); expect(observed).toHaveLength(2);
      await expect(f.analyzer.submit({ ...request, draft_revision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
      await writeFile(path.join(f.config.vault_path, f.draftPath), Buffer.concat([before[1]!, Buffer.from('\nUser edit\n')]));
      expect((await f.analyzer.result(request.request_id)).stale).toBe(true);
    } finally { await f.close(); }
  });
  it.each(['network','invalid','timeout'])('runs Relation independently after Review %s failure without a missing-reference notice', async mode => {
    const observed: string[] = [];
    const f = await analyzerFixture(async task => {
      observed.push(task); if (task === 'review') { if (mode === 'invalid') return '{}'; throw new CoreError('EXECUTION_FAILED', mode); } return emptyAnalysis(task);
    });
    try {
      await f.analyzer.settings.save({ default_profile: 'knowledge', profiles: [analysisProfile('output')] });
      const request = f.request(); await f.analyzer.submit(request); await f.analyzer.wait();
      expect(observed).toEqual(['review','relation']); const job = f.analyzer.get(request.request_id)!;
      expect(job).toMatchObject({ status: 'failed', review: { status: 'failed' }, relation: { status: 'succeeded', error: null } });
      const result = await f.analyzer.result(request.request_id); expect(result.review).toBeNull(); expect(result.relation).not.toBeNull();
      expect(JSON.stringify(result.record.relation)).not.toContain('REVIEW_UNAVAILABLE');
    } finally { await f.close(); }
  });
  it('stops subsequent analysis on a shared-input change and preserves user edits', async () => {
    const calls: string[] = []; const f = await analyzerFixture(async task => {
      calls.push(task); await writeFile(path.join(f.config.vault_path, f.draftPath), (await readFile(path.join(f.config.vault_path, f.draftPath))) + '\nUser edit\n'); return emptyAnalysis(task);
    });
    try {
      const request = f.request(); await f.analyzer.submit(request); await f.analyzer.wait();
      expect(calls).toEqual(['review']); expect(f.analyzer.get(request.request_id)?.relation.status).toBe('interrupted');
      expect(await readFile(path.join(f.config.vault_path, f.draftPath), 'utf8')).toContain('User edit');
    } finally { await f.close(); }
  });
  it('cancels a running model, refuses competing requests and restores durable outputs without calling a model', async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const f = await analyzerFixture(async (_task, _settings, _prompt, signal) => new Promise<string>((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
    try {
      const request = f.request(); await f.analyzer.submit(request); await ready;
      await expect(f.analyzer.submit(f.request())).rejects.toMatchObject({ code: 'JOB_BUSY' });
      expect((await f.analyzer.cancel(request.request_id)).status).toBe('interrupted');
      const saved = await f.analyzer.results.read(request.request_id);
      saved.job.status = 'running'; saved.job.review.status = 'running'; saved.job.relation.status = 'pending';
      saved.review.result = JSON.parse(emptyAnalysis('review')); await f.analyzer.results.save(saved);
      f.db.prepare('DELETE FROM analyzer_jobs').run(); let calls = 0;
      const recovered = new AnalyzerJobs(f.db, f.config, f.recall, () => false, async task => { calls++; return emptyAnalysis(task); });
      await recovered.initialize();
      expect(recovered.get(request.request_id)).toMatchObject({ status: 'interrupted', review: { status: 'succeeded' }, relation: { status: 'interrupted' } });
      expect((await recovered.result(request.request_id)).review).not.toBeNull(); expect(calls).toBe(0);
      await recovered.close();
    } finally { await f.close(); }
  });
});
