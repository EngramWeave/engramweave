import type Database from 'better-sqlite3';
import type { Config, RecallHit, RecallQuery, RecallResponse, RecallStatus } from '@engramweave/contracts';
import { pathKey } from '../config.js';
import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsAttributes } from '../files/windows.js';
import { CoreError } from '../errors.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown, stringList } from '../source/parse.js';
import { getDocument } from '../storage/registry.js';
import { indexMeta } from '../storage/database.js';
import { RecallSettingsStore, representationFingerprint } from './settings.js';
import { embed, queryInput, rerank } from './embedding.js';
import { RecallWorker } from './worker-client.js';
import type { StoredDocument } from './storage.js';

const kinds = ['knowledge', 'idea', 'research'];
type Note = { path: string; revision: string };
export class SemanticRecall {
  readonly settings: RecallSettingsStore;
  private storage: RecallWorker;
  private running: Promise<void> | null = null;
  private submitting = false;
  private abort = new AbortController();
  private stopping = false;
  private refreshPending = false;
  private progress = { processed_documents: 0, embedded_chunks: 0, reused_chunks: 0 };
  constructor(private readonly config: Config, private readonly db: Database.Database) {
    this.settings = new RecallSettingsStore(config.data_dir);
    this.storage = new RecallWorker(config.data_dir, pathKey(config.vault_path));
  }
  private eligible(): Note[] {
    return this.db.prepare("SELECT path,revision FROM documents WHERE kind IN ('knowledge','idea','research') AND state='ready' AND coalesce(json_extract(metadata_json,'$.lifecycle_status'),'active') IN ('active','') ORDER BY path_key").all() as Note[];
  }
  async status(): Promise<RecallStatus> {
    const info = await this.storage.call('info'); const { settings } = await this.settings.read(); const notes = this.eligible();
    const revisions = new Map(info.documents.map(note => [note.path, note.revision]));
    const paths = new Set(notes.map(note => note.path));
    const stale = notes.filter(note => revisions.get(note.path) !== note.revision).length + info.documents.filter(note => !paths.has(note.path)).length;
    return { state: info.fingerprint && info.fingerprint !== representationFingerprint(settings) ? 'rebuild_required' : info.state as RecallStatus['state'],
      initialized: info.initialized, indexed_documents: info.documents.length, indexed_chunks: info.chunks, eligible_documents: notes.length, stale_documents: stale,
      fingerprint: info.fingerprint, indexed_at: info.indexed_at, generation: info.generation, ...this.progress, error: info.error, diagnostics: [] };
  }
  async afterRefresh() {
    if (this.running || this.submitting) { this.refreshPending = true; return; }
    try { const status = await this.status(); if (status.initialized && status.state !== 'rebuild_required') await this.submit('update'); }
    catch { /* Index errors belong to the independent semantic status, never the successful Registry Job. */ }
  }
  async submit(mode: 'build' | 'update' | 'rebuild'): Promise<RecallStatus> {
    if (this.submitting) throw new CoreError('JOB_BUSY', 'A semantic index request is being accepted', 409);
    if (this.running) return this.status();
    this.submitting = true;
    try { return await this.accept(mode); } finally { this.submitting = false; }
  }
  private async accept(mode: 'build' | 'update' | 'rebuild'): Promise<RecallStatus> {
    if (this.stopping) throw new CoreError('CORE_UNAVAILABLE', 'Core is stopping', 503);
    if (this.running) return this.status();
    const { settings } = await this.settings.read();
    if (!settings.model.trim()) throw new CoreError('CONFIG_ERROR', 'Configure an Embedding model before building the semantic index', 400);
    let info;
    try { info = await this.storage.call('info'); }
    catch (error) {
      if (mode !== 'rebuild') throw error;
      await this.storage.close();
      const suffix = `.preserved-${randomUUID()}`;
      for (const name of ['semantic.sqlite', 'semantic.sqlite-journal', 'semantic.sqlite-wal', 'semantic.sqlite-shm']) {
        const filename = path.join(this.config.data_dir, name);
        const stat = await lstat(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (await windowsAttributes([filename]))[0]?.reparse) throw new CoreError('DATABASE_ERROR', 'Unsafe semantic cache was preserved; remove its alias before rebuilding', 503);
        await rename(filename, filename + suffix);
      }
      this.storage = new RecallWorker(this.config.data_dir, pathKey(this.config.vault_path)); info = await this.storage.call('info');
    }
    const fingerprint = representationFingerprint(settings);
    if (mode === 'update' && (!info.initialized || info.fingerprint !== fingerprint)) throw new CoreError('CONFIG_ERROR', 'Build or rebuild the compatible semantic index explicitly', 409);
    if (mode === 'build' && info.initialized) throw new CoreError('CONFIG_ERROR', 'The semantic index already exists; update or rebuild explicitly', 409);
    if (mode !== 'update') await this.storage.call('reset', fingerprint, mode === 'rebuild');
    this.progress = { processed_documents: 0, embedded_chunks: 0, reused_chunks: 0 };
    await this.storage.call('meta', { state: 'running', error: null });
    const notes = this.eligible(); const generation = indexMeta(this.db).index_generation;
    this.abort = new AbortController();
    this.running = this.update(notes, settings, fingerprint, generation).catch(async error => {
      await this.storage.call('meta', { state: this.stopping ? 'interrupted' : 'failed', error: error instanceof CoreError ? error.message : 'Semantic indexing failed; retry explicitly.' });
    }).finally(async () => {
      this.running = null;
      if (this.refreshPending && !this.stopping) { this.refreshPending = false; await this.afterRefresh(); }
    });
    void this.running.catch(() => {});
    return this.status();
  }
  private async current(note: Note): Promise<StoredDocument> {
    const file = await readMarkdown(this.config.vault_path, note.path); const parsed = parseMarkdown(note.path, file.bytes);
    if (file.revision !== note.revision || parsed.state !== 'ready' || parsed.lifecycle_status !== 'active' || parsed.kind === 'source') throw new CoreError('SOURCE_CHANGED', 'Library material changed; Refresh workspace and retry.', 409);
    const full = file.bytes.toString('utf8');
    const bodyLine = full.slice(0, full.length - parsed.body_markdown.length).split('\n').length;
    return { ...note, kind: parsed.kind, title: parsed.title, body: parsed.body_markdown, body_line: bodyLine, tags: stringList(parsed.metadata.tags) };
  }
  private async update(notes: Note[], settings: Awaited<ReturnType<RecallSettingsStore['read']>>['settings'], fingerprint: string, generation: number) {
    const info = await this.storage.call('info'); const paths = new Set(notes.map(note => note.path));
    await this.storage.call('remove', info.documents.filter(note => !paths.has(note.path)).map(note => note.path));
    const old = new Map(info.documents.map(note => [note.path, note.revision]));
    let key: string | undefined;
    for (const note of notes) {
      this.abort.signal.throwIfAborted();
      if (old.get(note.path) !== note.revision) {
        const current = await this.current(note);
        const chunks = await this.storage.call('prepare', current, fingerprint);
        const produced = new Map<string, number[]>();
        for (const chunk of chunks) {
          chunk.vector ??= produced.get(chunk.input_hash) ?? null;
          if (chunk.vector) { this.progress.reused_chunks++; continue; }
          key ??= await this.settings.key('embedding', settings.endpoint);
          const [vector] = await embed(settings, [chunk.input], key, this.abort.signal);
          chunk.vector = vector!;
          produced.set(chunk.input_hash, vector!);
          await this.storage.call('cache', chunk.input_hash, fingerprint, vector!);
          this.progress.embedded_chunks++;
        }
        await this.current(note);
        const projected = getDocument(this.db, note.path);
        if (projected?.state !== 'ready' || projected.revision !== note.revision) throw new CoreError('SOURCE_CHANGED', 'Registry changed during semantic indexing; retry after Refresh.', 409);
        await this.storage.call('publish', current, chunks);
      }
      this.progress.processed_documents++;
    }
    await this.storage.call('meta', { initialized: true, state: 'idle', error: null, indexed_at: new Date().toISOString(), generation: info.generation + 1, registry_generation: generation });
  }
  async test() {
    const { settings } = await this.settings.read();
    const vectors = await embed(settings, ['EngramWeave retrieval capability probe', 'A different capability probe'], await this.settings.key('embedding', settings.endpoint), this.abort.signal);
    if (settings.reranker_enabled) await rerank(settings, 'Which passage describes retrieval?', ['Search retrieves relevant notes.', 'The ocean contains salt.'], await this.settings.key('reranker', settings.reranker_endpoint), this.abort.signal);
    return { dimensions: vectors[0]!.length, reranker: settings.reranker_enabled ? 'available' as const : 'disabled' as const };
  }
  private async fresh(hits: RecallHit[], diagnostics: RecallResponse['diagnostics']) {
    const valid = new Map<string, RecallHit>();
    const checked = new Set<string>();
    for (const hit of hits) {
      if (checked.has(hit.path)) continue;
      checked.add(hit.path);
      try {
        const current = await this.current(hit);
        const candidates = hits.filter(candidate => candidate.path === hit.path);
        const verified = await this.storage.call('verifyEvidence', current, candidates);
        verified.forEach(candidate => valid.set(candidate.chunk_id, candidate));
        if (verified.length !== candidates.length) throw new Error('Cached evidence does not match current material');
      } catch { diagnostics.push({ code: 'SEMANTIC_EVIDENCE_STALE', message: 'This candidate changed or is unavailable; Refresh workspace before using it.', path: hit.path }); }
    }
    return hits.flatMap(hit => valid.has(hit.chunk_id) ? [valid.get(hit.chunk_id)!] : []);
  }
  async recall(query: RecallQuery, externalSignal?: AbortSignal): Promise<RecallResponse> {
    const signal = externalSignal ? AbortSignal.any([this.abort.signal, externalSignal]) : this.abort.signal;
    signal.throwIfAborted();
    if (!query.q.trim()) throw new CoreError('EMPTY_QUERY', 'Enter a semantic search query', 400);
    const started = performance.now(); const coverage = await this.status();
    if (!coverage.initialized || coverage.state === 'rebuild_required') throw new CoreError('CONFIG_ERROR', 'Build a compatible semantic index before semantic search', 409);
    if (!coverage.indexed_chunks) return { items: [], coverage, reranker: 'disabled', diagnostics: [], timings: { embedding_ms: 0, retrieval_ms: 0, rerank_ms: 0, total_ms: performance.now() - started } };
    const { settings } = await this.settings.read(); const diagnostics: RecallResponse['diagnostics'] = [];
    const embeddingStart = performance.now();
    const [vector] = await embed(settings, [queryInput(settings, query.q)], await this.settings.key('embedding', settings.endpoint), signal);
    const embeddingMs = performance.now() - embeddingStart;
    const retrievalStart = performance.now();
    const scope = query.scope ?? 'all';
    let hits = await this.storage.call('retrieve', query.q, vector!, scope === 'all' ? kinds : [scope === 'ideas' ? 'idea' : scope], settings.candidates);
    hits = await this.fresh(hits, diagnostics); // Do not send stale or discarded snippets to a remote ranker.
    const retrievalMs = performance.now() - retrievalStart;
    let ranking: RecallResponse['reranker'] = 'disabled'; let rerankMs = 0;
    if ((query.rerank ?? settings.reranker_enabled) && hits.length) {
      const t = performance.now();
      try {
        const scores = await rerank(settings, query.q, hits.map(hit => `${hit.title}\n${hit.heading}\n${hit.text}`), await this.settings.key('reranker', settings.reranker_endpoint), signal);
        hits = hits.map((hit, i) => ({ ...hit, rerank_score: scores[i]! })).sort((a, b) => b.rerank_score! - a.rerank_score! || b.score - a.score);
        ranking = 'applied';
      } catch { ranking = 'failed'; diagnostics.push({ code: 'RERANK_FAILED', message: 'Reranker failed; results retain the mixed retrieval ranking.', path: null }); }
      rerankMs = performance.now() - t;
    }
    hits = await this.fresh(hits, diagnostics);
    signal.throwIfAborted();
    const perNote = new Map<string, number>(); const selected = new Set<string>(); const items: RecallHit[] = []; let bytes = 0; let truncated = false;
    for (const hit of hits) {
      if (!selected.has(hit.path) && selected.size >= (query.limit ?? 20) || (perNote.get(hit.path) ?? 0) >= 3) continue;
      if (bytes + Buffer.byteLength(hit.text) > 8000) { truncated = true; continue; }
      bytes += Buffer.byteLength(hit.text); selected.add(hit.path); perNote.set(hit.path, (perNote.get(hit.path) ?? 0) + 1); items.push(hit);
    }
    if (truncated) diagnostics.push({ code: 'CONTEXT_BUDGET_REACHED', message: 'Some retrieved passages were omitted to keep the context within its byte budget.', path: null });
    return { items, coverage: await this.status(), reranker: ranking, diagnostics, timings: { embedding_ms: embeddingMs, retrieval_ms: retrievalMs, rerank_ms: rerankMs, total_ms: performance.now() - started } };
  }
  async context(requested: { path: string; revision: string; chunk_id: string }[]) {
    const diagnostics: RecallResponse['diagnostics'] = []; const stored = await this.storage.call('context', requested.map(item => item.chunk_id));
    const identities = new Set(requested.map(item => JSON.stringify([item.path, item.revision, item.chunk_id])));
    const valid = await this.fresh(stored.filter(hit => identities.has(JSON.stringify([hit.path, hit.revision, hit.chunk_id]))), diagnostics);
    let size = 0; const items = valid.filter(hit => { const n = Buffer.byteLength(hit.text); if (size + n > 8000) return false; size += n; return true; });
    return { items, diagnostics, truncated: items.length < requested.length };
  }
  async close() { this.stopping = true; this.refreshPending = false; this.abort.abort(); try { await this.running; } finally { await this.storage.close(); } }
}
