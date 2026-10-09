import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { httpRuntime, submitScan, finishedJob } from '../helpers/http.js';
import { writeDocument, manualSource } from '../helpers/fixtures.js';
import { analysisProfile } from '../helpers/analyzer.js';

describe('Analysis waiting and unrelated file operations', () => {
  it('permits unrelated Source Discard while a model waits, protects its own Source/Draft, and cancels without another model call', async () => {
    let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; }); let calls = 0;
    const model = createServer((_request, _response) => { calls++; started(); });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const address = model.address(); if (!address || typeof address === 'string') throw new Error('Model address unavailable');
    const source = '20_Sources/target.md'; const other = '20_Sources/unrelated.md'; const draft = '30_Drafts/target.md';
    const f = await httpRuntime(async vault => {
      await writeDocument(vault, source, manualSource('Only under condition A.', 'processing_status: compiled\n'));
      await writeDocument(vault, other, manualSource('Unrelated material.'));
      await writeDocument(vault, draft, `---\ntype: draft\ntitle: Target\nlifecycle_status: active\nsources: ["[[${source}]]"]\n---\nAlways applies.\n`);
    });
    const post = async (route: string, body: unknown) => f.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      await finishedJob(f.request, (await submitScan(f.request)).job.id);
      await f.request('/v1/analysis/templates');
      const profile = analysisProfile(); for (const task of ['review','relation'] as const) profile[task].execution.endpoint = `http://127.0.0.1:${address.port}/v1`;
      expect((await post('/v1/analysis/settings', { settings: { default_profile: profile.id, profiles: [profile] } })).status).toBe(200);
      const sourceDocument = await (await f.request(`/v1/documents?path=${source}`)).json() as { revision: string };
      const draftDocument = await (await f.request(`/v1/draft?path=${draft}`)).json() as { revision: string };
      const id = randomUUID(); expect((await post('/v1/analyses', { request_id: id, source_path: source, source_revision: sourceDocument.revision, draft_path: draft, draft_revision: draftDocument.revision })).status).toBe(202);
      await pending;
      const own = await post('/v1/source-batches', { id: randomUUID(), action: 'discard', items: [{ path: source, revision: sourceDocument.revision, request_id: randomUUID() }] }); expect(own.status).toBe(409);
      const otherDocument = await (await f.request(`/v1/documents?path=${other}`)).json() as { revision: string };
      const batchId = randomUUID(); expect((await post('/v1/source-batches', { id: batchId, action: 'discard', items: [{ path: other, revision: otherDocument.revision, request_id: randomUUID(), related: [] }] })).status).toBe(202);
      for (let i = 0; i < 200; i++) {
        const result = await (await f.request(`/v1/source-batches?id=${batchId}`)).json() as { status: string; items: { status: string }[] };
        if (result.status !== 'running') { expect(result.items[0]?.status).toBe('succeeded'); break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect((await (await f.request(`/v1/documents?path=${other}`)).json()).lifecycle_status).toBe('discarded');
      expect((await (await f.request(`/v1/jobs/${id}`)).json()).status).toBe('running');
      expect((await (await post('/v1/analysis/cancel', { id })).json()).status).toBe('interrupted'); expect(calls).toBe(1);
    } finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await f.cleanup(); }
  });
});
