import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { RecallStorage } from '../../packages/core/src/recall/storage.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import type { Chunk } from '../../packages/core/src/recall/chunks.js';
it('measures native mixed retrieval over 10000 1024-dimensional synthetic chunks without a corpus prefix cutoff', async () => {
  const runtime = await isolatedRuntime(); await mkdir(runtime.config.data_dir);
  const store = new RecallStorage(runtime.config.data_dir, 'performance');
  try {
    store.reset('benchmark'); const vector = Array(1024).fill(0) as number[]; vector[0] = 1;
    const chunks: (Chunk & { vector: number[] })[] = Array.from({ length: 10000 }, (_, i) => ({ chunk_id: `chunk-${i}`, input_hash: `hash-${i}`, heading: 'Benchmark', text: i === 9999 ? 'tailtarget 超导证据' : `filler material ${i}`, start_line: i + 1, end_line: i + 1, input: '', vector }));
    store.publish({ path: '50_Research/scale.md', kind: 'research', title: 'Scale fixture', revision: 'a'.repeat(64), body: '', body_line: 1, tags: [] }, chunks);
    store.meta({ initialized: true, state: 'idle' });
    const elapsed: number[] = [];
    for (let i = 0; i < 12; i++) { const start = performance.now(); const hits = store.retrieve('tailtarget 超导', vector, ['research'], 40); elapsed.push(performance.now() - start); expect(hits.some(hit => hit.chunk_id === 'chunk-9999')).toBe(true); }
    const p95 = [...elapsed].sort((a, b) => a - b)[Math.ceil(elapsed.length * 0.95) - 1]!;
    await mkdir('.local/p2-c1', { recursive: true }); await writeFile('.local/p2-c1/performance.json', JSON.stringify({ corpus: 'synthetic native retrieval benchmark; no model calls or user notes', chunks: 10000, dimensions: 1024, p95_ms: p95, queries_ms: elapsed }, null, 2));
    expect(p95).toBeLessThan(300);
  } finally { store.close(); await runtime.cleanup(); }
}, 60000);
