import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpRuntime, submitScan, finishedJob } from '../helpers/http.js';
import { writeDocument } from '../helpers/fixtures.js';
import { recallCases, waitSemanticIndex } from '../helpers/recall.js';
import { defaultRecallSettings } from '../../packages/core/src/recall/settings.js';
import type { RecallResponse, RecallSettings } from '@engramweave/contracts';

it.skipIf(process.env.ENGRAMWEAVE_REAL_RECALL !== '1')('evaluates real Qwen hybrid retrieval and reranking on hand-labelled synthetic notes', async () => {
  const models = async (endpoint: string) => (await (await fetch(`${endpoint}/models`)).json()).data[0].id as string;
  const settings: RecallSettings = { ...defaultRecallSettings,
    endpoint: process.env.ENGRAMWEAVE_EMBEDDING_ENDPOINT ?? 'http://127.0.0.1:8095/v1',
    reranker_endpoint: process.env.ENGRAMWEAVE_RERANKER_ENDPOINT ?? 'http://127.0.0.1:8086/v1',
    model: '', reranker_model: '', timeout_seconds: 60,
  };
  [settings.model, settings.reranker_model] = await Promise.all([models(settings.endpoint), models(settings.reranker_endpoint)]);
  const runtime = await httpRuntime(async vault => {
    for (const [relative, title, body] of recallCases) await writeDocument(vault, relative, `# ${title}\n\n${body}`);
    await writeDocument(vault, '40_Knowledge/false-friend.md', '# Counter example\nvolatile 不是使变量读改写成为一个不可分割动作的锁；复习相关论文的引用次数也不是受试者的计数。');
    await writeDocument(vault, '10_Ideas/false-friend.md', '# 辨别主题\n读书笔记中的知识、发表、缓存、分析、模型和研究都只是标签，不证明任何一个具体结论。');
  });
  const post = async (route: string, body: unknown) => {
    const response = await runtime.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${JSON.stringify(result)}`); return result;
  };
  const rows: { path: string; query: string; hybrid_rank: number; reranked_rank: number; hybrid_ms: number; reranked_ms: number; rerank_ms: number; reranker: string }[] = [];
  try {
    const scan = await submitScan(runtime.request); expect((await finishedJob(runtime.request, scan.job.id)).status).toBe('succeeded');
    await post('/v1/recall/settings', { settings });
    expect(await post('/v1/recall/test', {})).toMatchObject({ dimensions: 1024 });
    await post('/v1/recall/index', { mode: 'build' });
    const status = await waitSemanticIndex(runtime.request); expect(status).toMatchObject({ state: 'idle', initialized: true, indexed_documents: 20 });
    for (const [relative, , , query] of recallCases) {
      const hybrid = await post('/v1/recall', { q: query, rerank: false }) as RecallResponse;
      const reranked = await post('/v1/recall', { q: query, rerank: true }) as RecallResponse;
      const rank = (result: RecallResponse) => { const paths = [...new Set(result.items.map(hit => hit.path))]; const i = paths.indexOf(relative); return i < 0 ? 0 : i + 1; };
      rows.push({ path: relative, query, hybrid_rank: rank(hybrid), reranked_rank: rank(reranked), hybrid_ms: hybrid.timings.total_ms, reranked_ms: reranked.timings.total_ms, rerank_ms: reranked.timings.rerank_ms, reranker: reranked.reranker });
    }
    const metrics = (key: 'hybrid_rank' | 'reranked_rank') => ({
      recall_at_10: rows.filter(row => row[key] > 0 && row[key] <= 10).length / rows.length,
      mrr_at_10: rows.reduce((sum, row) => sum + (row[key] > 0 && row[key] <= 10 ? 1 / row[key] : 0), 0) / rows.length,
      ndcg_at_10: rows.reduce((sum, row) => sum + (row[key] > 0 && row[key] <= 10 ? 1 / Math.log2(row[key] + 1) : 0), 0) / rows.length,
    });
    const percentile = (values: number[]) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
    const report = { date: new Date().toISOString(), corpus: '20 hand-labelled synthetic notes; not the user Vault', embedding_model: settings.model, reranker_model: settings.reranker_model, status,
      hybrid: metrics('hybrid_rank'), reranked: metrics('reranked_rank'), hybrid_p95_ms: percentile(rows.map(row => row.hybrid_ms)), reranked_p95_ms: percentile(rows.map(row => row.reranked_ms)), rerank_p95_ms: percentile(rows.map(row => row.rerank_ms)), rows };
    await mkdir('.local/p2-c1', { recursive: true }); await writeFile('.local/p2-c1/real-quality.json', JSON.stringify(report, null, 2));
    for (const directory of ['40_Knowledge/', '10_Ideas/', '50_Research/']) expect(rows.some(row => row.path.startsWith(directory) && row.reranked_rank > 0 && row.reranked_rank <= 10)).toBe(true);
    expect(rows.every(row => row.reranker === 'applied')).toBe(true);
    expect(report.hybrid.recall_at_10).toBeGreaterThanOrEqual(0.8);
    expect(report.reranked.recall_at_10).toBeGreaterThanOrEqual(0.8);
    const before = await runtime.request('/v1/recall/status').then(r => r.json());
    const refresh = await submitScan(runtime.request); await finishedJob(runtime.request, refresh.job.id);
    const unchanged = await waitSemanticIndex(runtime.request); expect(unchanged.embedded_chunks).toBe(0); expect(unchanged.indexed_chunks).toBe(before.indexed_chunks);
    // Current fragment evidence opens through the actual document endpoint.
    expect((await runtime.request(`/v1/documents?path=${encodeURIComponent(recallCases[0][0])}`)).status).toBe(200);
  } finally { await runtime.cleanup(); }
}, 240000);
