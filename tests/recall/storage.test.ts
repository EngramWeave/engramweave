import { describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { RecallStorage, type StoredDocument } from '../../packages/core/src/recall/storage.js';
import { splitChunks, terms } from '../../packages/core/src/recall/chunks.js';
import { isolatedRuntime } from '../helpers/runtime.js';

describe('semantic chunk and hybrid store invariants', () => {
  it('covers a long paragraph and code tail without losing Unicode or source positions', () => {
    const body = '# 章节\n\n' + '中文🧠 evidence '.repeat(1000) + '\n```ts\nconst tail = 42;\n```';
    const chunks = splitChunks('50_Research/paper.md', 'Evidence', body, 6);
    expect(chunks.map(c => c.text).join('')).toBe(body);
    expect(chunks.every(c => Buffer.byteLength(c.text) <= 800 && c.start_line >= 6 && c.end_line >= c.start_line)).toBe(true);
    expect(chunks.at(-1)!.text).toContain('tail = 42');
    expect(terms('知识编译系统 Qwen3-Embedding volatile.NET')).toContain('知识');
  });
  it('persists vectors, fuses duplicate candidates, filters kinds before top-k and retains failed replacement evidence', async () => {
    const runtime = await isolatedRuntime(); await mkdir(runtime.config.data_dir);
    let store = new RecallStorage(runtime.config.data_dir, 'vault');
    const fingerprint = 'f'.repeat(64);
    const doc = (path: string, kind: StoredDocument['kind'], body: string): StoredDocument => ({ path, kind, body, title: body, revision: 'a'.repeat(64), body_line: 1, tags: ['研究'] });
    const publish = (document: StoredDocument, vector: number[]) => {
      const chunks = store.prepare(document, fingerprint).map(c => ({ ...c, vector }));
      for (const chunk of chunks) store.cache(chunk.input_hash, fingerprint, vector);
      store.publish(document, chunks);
    };
    try {
      store.reset(fingerprint);
      publish(doc('40_Knowledge/k.md', 'knowledge', '知识编译系统'), [1, 0, 0]);
      publish(doc('10_Ideas/i.md', 'idea', 'Knowledge compiler experiment'), [0.9, 0.1, 0]);
      publish(doc('50_Research/r.md', 'research', '控制组研究'), [0.1, 0.9, 0]);
      store.meta({ initialized: true, state: 'idle' });
      const mixed = store.retrieve('知识', [1, 0, 0], ['knowledge', 'idea', 'research'], 40);
      expect(mixed[0]).toMatchObject({ path: '40_Knowledge/k.md', channels: ['bm25', 'embedding'] });
      expect(new Set(mixed.map(hit => hit.chunk_id)).size).toBe(mixed.length);
      expect(store.retrieve('知识', [1, 0, 0], ['research'], 1)[0]!.path).toBe('50_Research/r.md');
      const reused = store.prepare(doc('40_Knowledge/k.md', 'knowledge', '知识编译系统'), fingerprint);
      expect(reused[0]!.vector).not.toBeNull();
      expect(store.prepare(doc('40_Knowledge/k.md', 'knowledge', '知识编译系统'), 'other-model')[0]!.vector).toBeNull();
      expect(() => store.publish(doc('40_Knowledge/k.md', 'knowledge', 'replacement'), store.prepare(doc('40_Knowledge/k.md', 'knowledge', 'replacement'), fingerprint))).toThrow();
      expect(store.retrieve('知识', [1, 0, 0], ['knowledge'], 1)[0]!.text).toContain('知识编译系统');
      store.close(); store = new RecallStorage(runtime.config.data_dir, 'vault');
      expect(store.info().documents).toHaveLength(3);
      store.remove(['40_Knowledge/k.md']);
      expect(store.retrieve('知识', [1, 0, 0], ['knowledge'], 1)).toEqual([]);
      store.reset(fingerprint, true);
      expect(store.prepare(doc('40_Knowledge/k.md', 'knowledge', '知识编译系统'), fingerprint)[0]!.vector).toBeNull();
    } finally { store.close(); await runtime.cleanup(); }
  });
});
