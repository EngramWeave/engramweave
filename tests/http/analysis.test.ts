import { describe, expect, it } from 'vitest';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { createHttp } from '../../packages/core/src/http.js';
import { API } from '@engramweave/contracts';
import { Value } from '@sinclair/typebox/value';

describe('Analyzer HTTP contract and result access', () => {
  it('validates fixed routes and explicit Drafts, preserves authentication and exposes read-only provenance', async () => {
    const f = await analyzerFixture(async task => emptyAnalysis(task));
    const jobs = new ScanJobs(f.db, f.config.vault_path, () => f.analyzer.busy());
    const server = createHttp(f.config, { token: 'analysis-test-token', status: 'ready' }, () => ({ db: f.db, jobs, analyzer: f.analyzer, instance_id: 'fixture' }));
    const headers = { host: `127.0.0.1:${f.config.port}`, authorization: 'Bearer analysis-test-token' };
    try {
      expect((await server.inject({ method: 'GET', url: '/v1/analysis/settings', headers: { host: headers.host } })).statusCode).toBe(401);
      expect((await server.inject({ method: 'GET', url: '/v1/analysis/settings', headers: { ...headers, origin: 'http://example.com' } })).statusCode).toBe(403);
      const configs = await server.inject({ method: 'GET', url: '/v1/analysis/settings', headers }); expect(configs.statusCode).toBe(200);
      expect(Value.Check(API.analysisSettings.schema.response[200], configs.json())).toBe(true);
      expect((await server.inject({ method: 'POST', url: '/v1/analyses', headers, payload: { ...f.request(), arbitrary_path: '../secret' } })).statusCode).toBe(400);
      expect((await server.inject({ method: 'POST', url: '/v1/analyses', headers, payload: { source_path: f.sourcePath } })).statusCode).toBe(400);
      const request = f.request(); const submitted = await server.inject({ method: 'POST', url: '/v1/analyses', headers, payload: request }); expect(submitted.statusCode).toBe(202);
      expect(Value.Check(API.analyze.schema.response[202], submitted.json())).toBe(true); await f.analyzer.wait();
      const list = await server.inject({ method: 'GET', url: '/v1/jobs', headers }); expect(list.json().items[0].kind).toBe('analyze_draft');
      const result = await server.inject({ method: 'GET', url: `/v1/analysis/result?id=${request.request_id}`, headers }); expect(result.statusCode).toBe(200);
      expect(Value.Check(API.analysisResult.schema.response[200], result.json())).toBe(true); expect(result.json().record.snapshot.input.source.annotation).toContain('understanding');
      expect(JSON.stringify(result.json())).not.toContain('analysis-test-token');
      expect((await server.inject({ method: 'POST', url: '/v1/analysis/result', headers, payload: {} })).statusCode).toBe(404);
    } finally { await server.close(); await jobs.close(); await f.close(); }
  });
});
