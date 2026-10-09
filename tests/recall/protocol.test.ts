import { afterEach, expect, it, vi } from 'vitest';
import { embed, normalizeVector, rerank } from '../../packages/core/src/recall/embedding.js';
import { defaultRecallSettings } from '../../packages/core/src/recall/settings.js';
afterEach(() => vi.unstubAllGlobals());
const settings = { ...defaultRecallSettings, model: 'test' };
it('orders batch embeddings by input index and rejects missing/duplicate indices and invalid values', async () => {
  const respond = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })));
  respond([{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [2, 0] }]);
  expect(await embed(settings, ['a', 'b'], '')).toEqual([[1, 0], [0, 1]]);
  for (const data of [[], [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }], [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0, 0] }]]) {
    respond(data); await expect(embed(settings, ['a', 'b'], '')).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
  }
  for (const vector of [[0, 0], [Infinity, 1], [NaN], ['bad'], []]) expect(() => normalizeVector(vector)).toThrow();
});
it('validates all reranker indices without trusting response order or exposing service bodies', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.2 }, { index: 0, relevance_score: 0.8 }] }))));
  expect(await rerank(settings, 'query', ['a', 'b'], '')).toEqual([0.8, 0.2]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('secret upstream diagnostic', { status: 500 })));
  await expect(embed(settings, ['a'], '')).rejects.toMatchObject({ message: 'Recall service returned HTTP 500' });
});
