import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzerFixture, analysisProfile } from '../helpers/analyzer.js';

describe('Analyzer credential boundaries', () => {
  it('protects credentials per Profile/task/endpoint without returning or borrowing them', async () => {
    const f = await analyzerFixture();
    try {
      const profile = analysisProfile(); profile.review.execution.endpoint = 'https://example.com/v1'; profile.relation.execution.endpoint = 'https://example.com/v1';
      const secret = 'isolated-analyzer-test-key-not-for-transmission';
      const saved = await f.analyzer.settings.save({ default_profile: profile.id, profiles: [profile] }, [{ profile_id: profile.id, task: 'review', api_key: secret }]);
      expect(saved.credentials).toEqual([{ profile_id: profile.id, review: true, relation: false }]); expect(JSON.stringify(saved)).not.toContain(secret);
      expect(await readFile(path.join(f.config.data_dir, 'analysis-knowledge-review.dpapi'), 'utf8')).not.toContain(secret);
      expect(await f.analyzer.settings.key(profile.id, 'review', profile.review.execution.endpoint)).toBe(secret);
      await expect(f.analyzer.settings.key(profile.id, 'relation', profile.relation.execution.endpoint)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
      profile.review.execution.endpoint = 'https://other.example/v1';
      expect((await f.analyzer.settings.save({ default_profile: profile.id, profiles: [profile] })).credentials[0]?.review).toBe(false);
      await expect(f.analyzer.settings.key(profile.id, 'review', profile.review.execution.endpoint)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    } finally { await f.close(); }
  }, 30_000);
});
