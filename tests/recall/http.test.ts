import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { API, type RecallResponse } from '@engramweave/contracts';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { writeDocument, manualSource } from '../helpers/fixtures.js';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultRecallSettings } from '../../packages/core/src/recall/settings.js';
import { httpCore } from '../helpers/http.js';
import { splitChunks } from '../../packages/core/src/recall/chunks.js';
import { waitSemanticIndex as waitIndex } from '../helpers/recall.js';
it('keeps first indexing explicit, updates only changed inputs, validates current evidence and isolates model failures from registration', async () => {
  let calls = 0; let inputs = 0; let failed = false; let rankFailed = false;
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part); const body = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) { calls++; inputs += body.input.length; if (failed) { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ data: body.input.map((input: string, index: number) => ({ index, embedding: input.includes('控制') ? [0, 1, 0] : [1, 0.1, 0] })) }));
    } else { if (rankFailed) { res.statusCode = 500; res.end('{}'); return; } res.end(JSON.stringify({ results: body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 / (index + 1) })) })); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address() as { port: number };
  const runtime = await httpRuntime(async vault => {
    await writeDocument(vault, '10_Ideas/idea.md', '# 新点子\n知识编译系统的新设计');
    await writeDocument(vault, '40_Knowledge/knowledge.md', '# Knowledge\n知识编译系统');
    await writeDocument(vault, '50_Research/research.md', '# Research\n控制组研究');
    await writeDocument(vault, '20_Sources/source.md', manualSource());
  });
  const post = (route: string, body: unknown) => runtime.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const scan = await submitScan(runtime.request); expect((await finishedJob(runtime.request, scan.job.id)).status).toBe('succeeded');
    expect(calls).toBe(0);
    const settings = { ...defaultRecallSettings, model: 'embedding', endpoint: `http://127.0.0.1:${address.port}/v1`, reranker_endpoint: `http://127.0.0.1:${address.port}/v1` };
    expect((await post('/v1/recall/settings', { settings })).status).toBe(200); expect(calls).toBe(0);
    expect((await post('/v1/recall/index', { mode: 'update' })).status).toBe(409);
    const competing = await Promise.all([post('/v1/recall/index', { mode: 'build' }), post('/v1/recall/index', { mode: 'build' })]);
    expect(competing.map(response => response.status).sort()).toEqual([202, 409]);
    expect(await waitIndex(runtime.request)).toMatchObject({ state: 'idle', initialized: true, indexed_documents: 3 });
    const initialInputs = inputs;
    const second = await submitScan(runtime.request); const secondDone=await finishedJob(runtime.request, second.job.id); await waitIndex(runtime.request,s=>s.generation===secondDone.summary!.index_generation); expect(inputs).toBe(initialInputs);
    const result = await (await post('/v1/recall', { q: '知识', rerank: true })).json() as RecallResponse;
    expect([...Value.Errors(API.recall.schema.response[200], result)]).toEqual([]);
    expect(result.reranker).toBe('applied'); expect(result.items.map(hit => hit.kind)).toEqual(expect.arrayContaining(['idea', 'knowledge', 'research']));
    expect(result.items.every(hit => hit.path !== '20_Sources/source.md')).toBe(true);
    const metadataBefore = inputs;
    const knowledge = path.join(runtime.config.vault_path, '40_Knowledge/knowledge.md');
    await writeFile(knowledge, '---\ncaptured_at: 2026-10-09\n---\n# Knowledge\n知识编译系统');
    expect(inputs).toBe(metadataBefore);
    const changed = await submitScan(runtime.request); const changedDone=await finishedJob(runtime.request, changed.job.id); await waitIndex(runtime.request,s=>s.generation===changedDone.summary!.index_generation); expect(inputs).toBe(metadataBefore);
    const evidence = result.items.find(hit => hit.kind === 'knowledge')!;
    const context = await (await post('/v1/recall/context', { items: [evidence].map(({ path, revision, chunk_id }) => ({ path, revision, chunk_id })) })).json();
    expect(context.items).toEqual([]);
    await writeFile(knowledge, '---\nlifecycle_status: discarded\n---\n# Knowledge\n知识编译系统');
    const fresh = await (await post('/v1/recall', { q: '知识', rerank: true })).json() as RecallResponse;
    expect(fresh.items.some(hit => hit.kind === 'knowledge')).toBe(false);
    expect(fresh.diagnostics.some(d => d.code === 'SEMANTIC_EVIDENCE_STALE')).toBe(true);
    rankFailed = true;
    expect((await (await post('/v1/recall', { q: '知识', rerank: true })).json()).reranker).toBe('failed');
    rankFailed = false; failed = true;
    await writeDocument(runtime.config.vault_path, '10_Ideas/idea.md', '# 新点子\n新正文');
    const failing = await submitScan(runtime.request); expect((await finishedJob(runtime.request, failing.job.id)).status).toBe('succeeded');
    expect(await waitIndex(runtime.request,s=>s.state==='failed')).toMatchObject({ state: 'failed', initialized: true });
    expect((await runtime.request('/v1/search?scope=ideas&q=新正文')).status).toBe(200);
    failed = false;
    await post('/v1/recall/index', { mode: 'update' }); expect((await waitIndex(runtime.request)).state).toBe('idle');
    expect(await readFile(knowledge, 'utf8')).toContain('lifecycle_status: discarded');
    const beforeRestart = calls; await runtime.core.close();
    const restarted = await httpCore(runtime.config);
    try { await delay(30); expect(calls).toBe(beforeRestart); expect((await restarted.request('/v1/documents?path=50_Research/research.md')).status).toBe(200); }
    finally { await restarted.core.close(); }
    const semanticFile = path.join(runtime.config.data_dir, 'semantic.sqlite');
    const futureCache = new Database(semanticFile); futureCache.pragma('user_version=2'); futureCache.close();
    const original = await readFile(semanticFile);
    const recoverable = await httpCore(runtime.config);
    try {
      expect((await (await recoverable.request('/v1/status')).json()).semantic_index.state).toBe('failed');
      expect((await recoverable.request('/v1/documents?path=50_Research/research.md')).status).toBe(200);
      await post('/v1/recall/index', { mode: 'rebuild' }); expect((await waitIndex(recoverable.request)).state).toBe('idle');
      const backup = (await readdir(runtime.config.data_dir)).find(name => name.startsWith('semantic.sqlite.preserved-'))!;
      expect(await readFile(path.join(runtime.config.data_dir, backup))).toEqual(original);
      await post('/v1/recall/settings', { settings: { ...settings, model: 'another-vector-space' } });
      const unchangedInputs = inputs;
      const incompatible = await submitScan(recoverable.request); await finishedJob(recoverable.request, incompatible.job.id);
      expect((await waitIndex(recoverable.request)).state).toBe('rebuild_required'); expect(inputs).toBe(unchangedInputs);
      expect((await post('/v1/recall/index', { mode: 'update' })).status).toBe(409);
      await post('/v1/recall/index', { mode: 'rebuild' }); expect((await waitIndex(recoverable.request)).state).toBe('idle');
      expect(inputs).toBeGreaterThan(unchangedInputs);
    } finally { await recoverable.core.close(); }
  } finally { await runtime.cleanup(); await new Promise<void>(resolve => provider.close(() => resolve())); }
}, 60000);

it('deduplicates chunks, retains completed cache batches and never publishes a partial failed replacement', async () => {
  const requests: string[][] = []; let failAt = -1;
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString()); requests.push(body.input);
    res.setHeader('content-type', 'application/json');
    if (requests.length === failAt) { res.statusCode = 503; res.end('{}'); return; }
    res.end(JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, index + 1, 0] })).reverse() }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  const repeated = 'repeat evidence '.repeat(50).slice(0, 800);
  const original = '# Batch\n' + repeated.repeat(3) + Array.from({ length: 40 }, (_, index) => `${index} distinct evidence `.padEnd(800, '.')).join('');
  const runtime = await httpRuntime(async vault => { await writeDocument(vault, '40_Knowledge/batch.md', original); });
  const post = (route: string, body: unknown) => runtime.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await finishedJob(runtime.request, (await submitScan(runtime.request)).job.id);
    await post('/v1/recall/settings', { settings: { ...defaultRecallSettings, model: 'batch', endpoint: `http://127.0.0.1:${address.port}/v1` } });
    await post('/v1/recall/index', { mode: 'build' });
    const built = await waitIndex(runtime.request);
    expect(built).toMatchObject({ state: 'idle', indexed_documents: 1 });
    const distinct = new Set(splitChunks('40_Knowledge/batch.md', 'Batch', original, 1).map(chunk => chunk.input_hash)).size;
    expect(requests).toHaveLength(distinct);
    expect(requests.every(inputs => inputs.length === 1)).toBe(true);
    expect(requests.flat()).toHaveLength(distinct);
    const db = new Database(path.join(runtime.config.data_dir, 'semantic.sqlite'), { readonly: true });
    const before = db.prepare('SELECT path,revision FROM docs').all(); db.close();
    await writeDocument(runtime.config.vault_path, '40_Knowledge/batch.md', '# Changed\n' + Array.from({ length: 40 }, (_, index) => `${index} changed replacement `.padEnd(800, '!')).join(''));
    failAt = requests.length + 18;
    await finishedJob(runtime.request, (await submitScan(runtime.request)).job.id);
    expect((await waitIndex(runtime.request, status => status.state === 'failed')).state).toBe('failed');
    const preserved = new Database(path.join(runtime.config.data_dir, 'semantic.sqlite'), { readonly: true });
    expect(preserved.prepare('SELECT path,revision FROM docs').all()).toEqual(before); preserved.close();
    const retryStart = requests.length; failAt = -1;
    await post('/v1/recall/index', { mode: 'update' });
    expect((await waitIndex(runtime.request)).state).toBe('idle');
    const successfulInputs = requests.slice(retryStart - 18, retryStart - 1).flat();
    expect(requests.slice(retryStart).flat().some(input => successfulInputs.includes(input))).toBe(false);
    const unchanged = requests.length;
    const scan = await finishedJob(runtime.request, (await submitScan(runtime.request)).job.id);
    await waitIndex(runtime.request, status => status.generation === scan.summary!.index_generation);
    expect(requests).toHaveLength(unchanged);
  } finally { await runtime.cleanup(); await new Promise<void>(resolve => provider.close(() => resolve())); }
}, 60000);
