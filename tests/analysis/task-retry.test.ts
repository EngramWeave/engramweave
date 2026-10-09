import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture, analysisProfile, emptyAnalysis } from '../helpers/analyzer.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';

describe('explicit individual Analyzer selection', () => {
  it.each(['none','input','output'] as const)('runs only Relation with compatible %s Review provenance, retaining Review history', async reuse => {
    const calls: { task: string; input: Record<string,unknown> }[] = [];
    const f = await analyzerFixture(async (task,_settings,prompt) => { calls.push({ task, input: JSON.parse(prompt) }); return emptyAnalysis(task); });
    try {
      await f.analyzer.settings.save({ default_profile: 'knowledge', profiles: [analysisProfile(reuse)] });
      const first = f.request(); await f.analyzer.submit(first); await f.analyzer.wait();
      const request = { ...f.request(), task: 'relation' as const }; await f.analyzer.submit(request); await f.analyzer.wait();
      expect(calls.map(item => item.task)).toEqual(['review','relation','relation']);
      const job = f.analyzer.get(request.request_id)!; expect(job.review.status).toBe('skipped'); expect(job.status).toBe('succeeded');
      expect(job.review_reference_id).toBe(reuse === 'none' ? undefined : first.request_id);
      expect(Object.hasOwn(calls[2]!.input,'review_reference')).toBe(reuse === 'output');
      expect(f.analyzer.latestForDraft(f.draftPath,'review')?.id).toBe(first.request_id);
      expect((await f.analyzer.submit(request)).reused).toBe(true); expect(calls).toHaveLength(3);
    } finally { await f.close(); }
  });
  it('uses the edited Draft for only the selected task, while preserving the other stale result', async () => {
    const calls: string[] = []; const f = await analyzerFixture(async task => { calls.push(task); return emptyAnalysis(task); });
    try {
      const first = f.request(); await f.analyzer.submit(first); await f.analyzer.wait();
      await writeFile(path.join(f.config.vault_path,f.draftPath), (await readFile(path.join(f.config.vault_path,f.draftPath))) + '\nUser edit\n');
      const current = await readMarkdown(f.config.vault_path,f.draftPath);
      const second = { ...f.request(), draft_revision: current.revision, task: 'review' as const }; await f.analyzer.submit(second); await f.analyzer.wait();
      expect(calls).toEqual(['review','relation','review']); expect((await f.analyzer.result(first.request_id)).stale).toBe(true);
      expect(f.analyzer.latestForDraft(f.draftPath,'relation')?.id).toBe(first.request_id); expect((await f.analyzer.result(second.request_id)).stale).toBe(false);
    } finally { await f.close(); }
  });
  it.each(['draft','profile','template'] as const)('runs Relation independently after %s changes without borrowing an incompatible Review', async changed => {
    const inputs:Record<string,unknown>[]=[];const f=await analyzerFixture(async(task,_settings,prompt)=>{if(task==='relation')inputs.push(JSON.parse(prompt));return emptyAnalysis(task);});
    try {
      await f.analyzer.settings.save({default_profile:'knowledge',profiles:[analysisProfile('output')]});const first=f.request();await f.analyzer.submit(first);await f.analyzer.wait();
      if(changed==='draft') await writeFile(path.join(f.config.vault_path,f.draftPath),(await readFile(path.join(f.config.vault_path,f.draftPath)))+'\nNew user context\n');
      if(changed==='profile'){const profile=analysisProfile('output');profile.review.execution.model='different';await f.analyzer.settings.save({default_profile:'knowledge',profiles:[profile]});}
      if(changed==='template'){const filename=path.join(f.config.vault_path,'90_System/Prompts/Review/Knowledge.md');await writeFile(filename,(await readFile(filename))+'\nAdditional instruction.\n');}
      const draft=await readMarkdown(f.config.vault_path,f.draftPath);const next={...f.request(),draft_revision:draft.revision,task:'relation' as const};await f.analyzer.submit(next);await f.analyzer.wait();
      expect(f.analyzer.get(next.request_id)).toMatchObject({status:'succeeded',review:{status:'skipped'}});expect(f.analyzer.get(next.request_id)?.review_reference_id).toBeUndefined();expect(inputs.at(-1)).not.toHaveProperty('review_reference');expect(f.analyzer.latestForDraft(f.draftPath,'review')?.id).toBe(first.request_id);
    } finally {await f.close();}
  });
});
