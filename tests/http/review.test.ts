import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DraftReviewSchema, PublishDraftResponseSchema } from '@engramweave/contracts';
import { createHttp } from '../../packages/core/src/http.js';
import { DraftPublications } from '../../packages/core/src/review/publication.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';

it('serves current Draft review and protected publication contracts through the authenticated local API', async () => {
  const f = await analyzerFixture(async task => emptyAnalysis(task));
  const run = f.request(); await f.analyzer.submit(run); await f.analyzer.wait();
  const jobs = new ScanJobs(f.db, f.config.vault_path, () => false);
  const publications = new DraftPublications(f.config, f.db, () => false, id => f.analyzer.get(id)); await publications.initialize();
  const server = createHttp(f.config, { token: 'fixture', status: 'ready' }, () => ({ db: f.db, jobs, analyzer: f.analyzer, publications, instance_id: 'fixture' }));
  const headers = { host: `127.0.0.1:${f.config.port}`, authorization: 'Bearer fixture' };
  try {
    const response = await server.inject({ method: 'GET', url: `/v1/draft-review?path=${encodeURIComponent(f.draftPath)}`, headers });
    expect(response.statusCode).toBe(200); const review = response.json(); expect([...Value.Errors(DraftReviewSchema, review)]).toEqual([]);
    expect(review.analysis.id).toBe(run.request_id); expect(review.source.annotation).toContain('broader');
    const payload = { request_id: run.request_id, draft_path: f.draftPath, draft_revision: review.draft.revision, source_path: f.sourcePath, source_revision: review.source.revision,
      analysis_id: run.request_id, target_path: '40_Knowledge/Accepted.md', related_drafts: review.related_drafts.map(({ path, revision }: { path: string; revision: string }) => ({ path, revision })) };
    expect((await server.inject({ method: 'POST', url: '/v1/draft-publications', headers: { ...headers, authorization: '' }, payload })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/draft-publications', headers: { ...headers, origin: 'app://obsidian.md' }, payload })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/v1/draft-publications', headers, payload: { ...payload, target_path: '50_Research/no.md' } })).statusCode).toBe(400);
    const published = await server.inject({ method: 'POST', url: '/v1/draft-publications', headers, payload });
    expect(published.statusCode).toBe(200); expect([...Value.Errors(PublishDraftResponseSchema, published.json())]).toEqual([]);
    const again = await server.inject({ method: 'GET', url: `/v1/draft-review?path=${encodeURIComponent(f.draftPath)}`, headers });
    expect(again.json().publication.status).toBe('completed'); expect(again.json().source.processing_status).toBe('archived'); expect(again.json().related_drafts).toEqual([]);
    const formal = await server.inject({ method: 'GET', url: '/v1/documents?path=40_Knowledge%2FAccepted.md', headers });
    expect(formal.statusCode).toBe(200); expect(formal.json().index_stale).toBe(false); expect(formal.json().original_references[0].target_path).toBe(f.sourcePath);
  } finally { await server.close(); await publications.close(); await jobs.close(); await f.close(); }
});
