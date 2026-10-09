import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture, analysisProfile, emptyAnalysis } from '../helpers/analyzer.js';
import { loadAnalysisTemplate } from '../../packages/core/src/analysis/templates.js';

describe('Task-specific Review context reuse', () => {
  it.each(['input','output','none'] as const)('preserves Relation own context and includes Review-only evidence only for %s mode', async reuse => {
    const prompts: Record<string,unknown>[] = [];
    const f = await analyzerFixture(async (_task, _settings, prompt) => { prompts.push(JSON.parse(prompt)); return emptyAnalysis(_task); });
    try {
      const profile = analysisProfile(reuse);
      for (const task of ['review','relation'] as const) {
        const template = await loadAnalysisTemplate(f.config.vault_path, profile[task].template_path);
        await writeFile(path.join(f.config.vault_path, template.path), template.content.replace('scope: all', `scope: ${task === 'review' ? 'knowledge' : 'research'}`));
      }
      const research = { ...f.hit, path: '50_Research/relation-only.md', kind: 'research' as const, chunk_id: 'relation-only' };
      const original = await f.recall.recall({ q: 'initial' });
      f.recall.recall = async query => ({ ...original, items: query.scope === 'research' ? [research] : [f.hit] });
      await f.analyzer.settings.save({ default_profile: profile.id, profiles: [profile] });
      await f.analyzer.submit(f.request()); await f.analyzer.wait();
      const relation = prompts[1]!;
      const library = relation.library as { items: { chunk_id: string }[] };
      expect(library.items.some(hit => hit.chunk_id === research.chunk_id)).toBe(true);
      expect(library.items.some(hit => hit.chunk_id === f.hit.chunk_id)).toBe(reuse === 'input');
      expect(Object.hasOwn(relation, 'review_reference')).toBe(reuse === 'output');
      expect(Object.hasOwn(relation, 'review_context_observations')).toBe(reuse === 'input');
    } finally { await f.close(); }
  });
});
