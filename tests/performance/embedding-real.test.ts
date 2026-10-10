import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { embed } from '../../packages/core/dist/recall/embedding.js';
import { defaultRecallSettings } from '../../packages/core/dist/recall/settings.js';
import { splitChunks } from '../../packages/core/dist/recall/chunks.js';
import { RecallStorage } from '../../packages/core/dist/recall/storage.js';
import { isolatedRuntime } from '../helpers/runtime.js';

it.skipIf(process.env.ENGRAMWEAVE_F_REAL_EMBEDDING !== '1')('compares bounded real Embedding batches on authorized notes and checks mixed retrieval evidence', async () => {
  const f = await isolatedRuntime(); await mkdir(f.config.data_dir);
  const store = new RecallStorage(f.config.data_dir, 'authorized-corpus');
  const manifest: { path: string; sha256: string; bytes: number }[] = JSON.parse(await readFile('.local/p2-f/corpus-manifest.json', 'utf8'));
  const selected = manifest.filter(item => /volatile|并发|线程|事务|索引/i.test(item.path) && item.bytes < 30000 && item.bytes > 1500).slice(0, 8);
  expect(selected.length).toBeGreaterThan(0);
  const documents = await Promise.all(selected.map(async item => ({ path: item.path, kind: 'knowledge' as const, revision: item.sha256, title: path.basename(item.path, '.md'), body: await readFile(path.join('.local/p2-f/corpus', item.path), 'utf8'), body_line: 1, tags: [] })));
  const chunks = documents.flatMap(document => splitChunks(document.path, document.title, document.body, 1).map(chunk => ({ document, chunk })));
  const chosen = [...new Map(chunks.map(item => [item.chunk.input_hash, item])).values()].slice(0, 32);
  const models = await (await fetch('http://127.0.0.1:8095/v1/models')).json() as { data: { id: string }[] };
  const settings = { ...defaultRecallSettings, model: models.data[0]!.id, timeout_seconds: 120 };
  const inputs = chosen.map(item => item.chunk.input);
  const samples: { mode: string; requests: number; elapsed_ms: number }[] = [];
  let sequential: number[][] = []; let batched: number[][] = [];
  try {
    await embed(settings, [inputs[0]!], '');
    const sizes = process.env.ENGRAMWEAVE_F_BATCH_SIZES?.split(',').map(Number) ?? [1,16,16,1];
    for (const size of sizes) {
      if (!Number.isInteger(size) || size < 1 || size > 16) throw new Error('Invalid benchmark batch size');
      const mode = size === 1 ? 'sequential' : `batch-${size}`;
      const start = performance.now(); const vectors: number[][] = [];
      for (let offset = 0; offset < inputs.length; offset += size) vectors.push(...await embed(settings, inputs.slice(offset, offset + size), ''));
      samples.push({ mode, requests: Math.ceil(inputs.length / size), elapsed_ms: performance.now() - start });
      if (size > 1) batched = vectors; else sequential = vectors;
    }
    const similarities = sequential.map((vector, index) => vector.reduce((sum, value, axis) => sum + value * batched[index]![axis]!, 0));
    expect(similarities.every(value => value > .995)).toBe(true);
    store.reset('f'.repeat(64));
    const vectors = new Map(chosen.map((item, index) => [item.chunk.chunk_id, batched[index]!]));
    // This bounded quality sample is explicitly partial; it does not claim full-library coverage.
    for (const document of documents) {
      const selectedChunks = chosen.filter(item => item.document.path === document.path).map(({ chunk }) => ({ ...chunk, vector: vectors.get(chunk.chunk_id)! }));
      if (selectedChunks.length) store.publish(document, selectedChunks);
    }
    const queries = [];
    for (const query of ['多线程同时修改数据时怎样避免计数丢失？','数据库只提交了一半怎样保持一致？']) {
      const [vector] = await embed(settings, [`Instruct: ${settings.query_instruction}\nQuery: ${query}`], '');
      queries.push({ query, results: store.retrieve(query, vector!, ['knowledge'], 20).slice(0, 5) });
    }
    await mkdir('.local/p2-f/performance', { recursive: true });
    await writeFile(`.local/p2-f/performance/${process.env.ENGRAMWEAVE_F_EMBEDDING_LABEL ?? 'embedding-real'}.json`, JSON.stringify({ model: settings.model, corpus: 'authorized third-party Markdown; partial 32-chunk sample', selected, chunks: chosen.length, samples, minimum_cosine: Math.min(...similarities), queries }, null, 2));
  } finally { store.close(); await f.cleanup(); }
}, 600000);
