import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { RecallHit } from '@engramweave/contracts';
import { splitChunks, terms, type Chunk } from './chunks.js';

export interface StoredDocument { path: string; kind: RecallHit['kind']; title: string; revision: string; body: string; body_line: number; tags: string[] }
export interface StoreInfo { initialized: boolean; fingerprint: string | null; dimensions: number; generation: number; indexed_at: string | null; state: string; error: string | null; documents: { path: string; revision: string }[]; chunks: number }
export class RecallStorage {
  private db: Database.Database;
  constructor(directory: string, vaultKey: string) {
    const filename = path.join(directory, 'semantic.sqlite');
    try { const s = lstatSync(filename); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('Unsafe semantic cache'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = new Database(filename);
    try { if (this.db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error(); }
    catch { this.db.close(); renameSync(filename, `${filename}.corrupt-${Date.now()}`); this.db = new Database(filename); }
    try {
    if ((this.db.pragma('user_version', { simple: true }) as number) > 1) throw new Error('Unsupported semantic cache schema');
    vec.load(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS info (id INTEGER PRIMARY KEY CHECK(id=1), vault TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, chunk_id TEXT UNIQUE NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE TABLE IF NOT EXISTS cache (hash TEXT NOT NULL, fingerprint TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(hash,fingerprint));
      CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(title,heading,tags,body, tokenize='unicode61');`);
    const row = this.db.prepare('SELECT * FROM info').get() as { vault: string; data: string } | undefined;
    if (row && row.vault !== vaultKey) throw new Error('Semantic cache belongs to another Vault');
    if (row) {
      const stored = JSON.parse(row.data);
      if (typeof stored.initialized !== 'boolean' || !(stored.fingerprint === null || typeof stored.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(stored.fingerprint)) ||
        !Number.isSafeInteger(stored.dimensions) || stored.dimensions < 0 || stored.dimensions > 8192 || !Number.isSafeInteger(stored.generation) || stored.generation < 0 ||
        !['not_built','idle','running','failed','interrupted'].includes(stored.state) || !(stored.error === null || typeof stored.error === 'string') ||
        !(stored.indexed_at === null || typeof stored.indexed_at === 'string' && Number.isFinite(Date.parse(stored.indexed_at)))) throw new Error('Invalid semantic cache metadata');
    }
    if (!row) this.db.prepare('INSERT INTO info VALUES(1,?,?)').run(vaultKey, JSON.stringify({ initialized: false, fingerprint: null, dimensions: 0, generation: 0, indexed_at: null, state: 'not_built', error: null }));
    if (this.info().state === 'running') this.meta({ state: 'interrupted', error: 'Core exited during semantic indexing; retry explicitly.' });
    this.db.pragma('user_version=1');
    } catch (error) { this.db.close(); throw error; }
  }
  info(): StoreInfo {
    const row = this.db.prepare('SELECT data FROM info WHERE id=1').get() as { data: string };
    return { ...JSON.parse(row.data), documents: this.db.prepare('SELECT path,revision FROM docs').all(), chunks: (this.db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n };
  }
  private properties(): Omit<StoreInfo, 'documents' | 'chunks'> {
    return JSON.parse((this.db.prepare('SELECT data FROM info WHERE id=1').get() as { data: string }).data);
  }
  meta(values: Record<string, unknown>) {
    const current = this.properties();
    this.db.prepare('UPDATE info SET data=? WHERE id=1').run(JSON.stringify({ ...current, ...values })); return this.info();
  }
  reset(fingerprint: string, force = false) {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM words; DELETE FROM chunks; DELETE FROM docs; DROP TABLE IF EXISTS vectors;');
      if (force) this.db.prepare('DELETE FROM cache WHERE fingerprint=?').run(fingerprint);
      this.meta({ initialized: false, fingerprint, dimensions: 0, state: 'running', error: null });
    })();
  }
  prepare(document: StoredDocument, fingerprint: string) {
    return splitChunks(document.path, document.title, document.body, document.body_line).map(chunk => {
      const found = this.db.prepare('SELECT vector FROM cache WHERE hash=? AND fingerprint=?').get(chunk.input_hash, fingerprint) as { vector: Buffer } | undefined;
      return { ...chunk, vector: found ? [...new Float32Array(found.vector.buffer.slice(found.vector.byteOffset, found.vector.byteOffset + found.vector.byteLength))] : null };
    });
  }
  cache(hash: string, fingerprint: string, vector: number[]) {
    const info = this.properties();
    if (info.dimensions && info.dimensions !== vector.length) throw new Error('Embedding dimensions changed; rebuild explicitly');
    this.db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?)').run(hash, fingerprint, Buffer.from(new Float32Array(vector).buffer));
  }
  remove(paths: string[]) {
    const dimensions = this.properties().dimensions;
    this.db.transaction(() => {
      for (const relative of paths) {
        const ids = this.db.prepare('SELECT id FROM chunks WHERE path=?').all(relative) as { id: number }[];
        for (const { id } of ids) { this.db.prepare('DELETE FROM words WHERE rowid=?').run(id); if (dimensions) this.db.prepare('DELETE FROM vectors WHERE rowid=?').run(BigInt(id)); }
        this.db.prepare('DELETE FROM chunks WHERE path=?').run(relative); this.db.prepare('DELETE FROM docs WHERE path=?').run(relative);
      }
    })();
  }
  publish(document: StoredDocument, chunks: (Chunk & { vector: number[] | null })[]) {
    const dimension = chunks[0]?.vector?.length ?? this.properties().dimensions;
    const info = this.properties();
    if (info.dimensions && dimension !== info.dimensions || chunks.some(chunk => !chunk.vector || chunk.vector.length !== dimension)) throw new Error('Incomplete or incompatible vectors');
    this.db.transaction(() => {
      if (!info.dimensions && dimension) { this.db.exec(`CREATE VIRTUAL TABLE vectors USING vec0(embedding float[${dimension}] distance_metric=cosine, kind text);`); this.meta({ dimensions: dimension }); }
      this.remove([document.path]);
      for (const chunk of chunks) {
        const hit: RecallHit = { chunk_id: chunk.chunk_id, path: document.path, kind: document.kind, title: document.title, heading: chunk.heading, revision: document.revision,
          text: chunk.text, start_line: chunk.start_line, end_line: chunk.end_line, score: 0, channels: [], rerank_score: null };
        const id = this.db.prepare('INSERT INTO chunks(chunk_id,path,kind,data) VALUES(?,?,?,?)').run(chunk.chunk_id, document.path, document.kind, JSON.stringify(hit)).lastInsertRowid;
        this.db.prepare('INSERT INTO vectors(rowid,embedding,kind) VALUES(?,?,?)').run(BigInt(id), Buffer.from(new Float32Array(chunk.vector!).buffer), document.kind);
        this.db.prepare('INSERT INTO words(rowid,title,heading,tags,body) VALUES(?,?,?,?,?)').run(id, terms(document.title).join(' '), terms(chunk.heading).join(' '), terms(document.tags.join(' ')).join(' '), terms(chunk.text).join(' '));
      }
      this.db.prepare('INSERT INTO docs VALUES(?,?)').run(document.path, document.revision);
    })();
  }
  retrieve(query: string, vector: number[], kinds: string[], count: number): RecallHit[] {
    if (vector.length !== this.properties().dimensions) throw new Error('Query embedding dimensions are incompatible');
    const placeholders = kinds.map(() => '?').join(',');
    const dense = this.db.prepare(`SELECT rowid FROM vectors WHERE embedding MATCH ? AND k=? AND kind IN (${placeholders}) ORDER BY distance`).all(Buffer.from(new Float32Array(vector).buffer), count, ...kinds) as { rowid: number }[];
    const queryTerms = [...new Set(terms(query))].slice(0, 80).map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const sparse = queryTerms ? this.db.prepare(`SELECT words.rowid FROM words JOIN chunks ON chunks.id=words.rowid WHERE words MATCH ? AND chunks.kind IN (${placeholders}) ORDER BY bm25(words,3,2,2,1),words.rowid LIMIT ?`).all(queryTerms, ...kinds, count) as { rowid: number }[] : [];
    const ranks = new Map<number, { score: number; channels: RecallHit['channels'] }>();
    for (const [channel, list] of [['bm25', sparse], ['embedding', dense]] as const) list.forEach((item, rank) => {
      const value = ranks.get(item.rowid) ?? { score: 0, channels: [] }; value.score += 1 / (61 + rank); value.channels.push(channel); ranks.set(item.rowid, value);
    });
    return [...ranks].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]).slice(0, count).map(([id, value]) => {
      const row = this.db.prepare('SELECT data FROM chunks WHERE id=?').get(id) as { data: string };
      return { ...JSON.parse(row.data), ...value };
    });
  }
  context(ids: string[]): RecallHit[] { return ids.flatMap(id => { const row = this.db.prepare('SELECT data FROM chunks WHERE chunk_id=?').get(id) as { data: string } | undefined; return row ? [JSON.parse(row.data) as RecallHit] : []; }); }
  verifyEvidence(document: StoredDocument, hits: RecallHit[]): RecallHit[] {
    const chunks = new Map(splitChunks(document.path, document.title, document.body, document.body_line).map(chunk => [chunk.chunk_id, chunk]));
    return hits.flatMap(hit => {
      const chunk = chunks.get(hit.chunk_id);
      if (!chunk || document.revision !== hit.revision || chunk.text !== hit.text) return [];
      return [{ ...hit, kind: document.kind, title: document.title, heading: chunk.heading, text: chunk.text, start_line: chunk.start_line, end_line: chunk.end_line }];
    });
  }
  close() { this.db.close(); }
}
