import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AnalysisProfile, AnalyzeRequest, RecallResponse, RecallHit } from '@engramweave/contracts';
import type { SemanticRecall } from '../../packages/core/src/recall/index.js';
import { isolatedRuntime } from './runtime.js';
import { writeDocument, manualSource } from './fixtures.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';
import { analysisTemplates } from '../../packages/core/src/analysis/templates.js';
import { AnalyzerJobs, type AnalyzerExecutor } from '../../packages/core/src/jobs/analyzer.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';

export const analysisProfile = (reuse: AnalysisProfile['reuse'] = 'none'): AnalysisProfile => ({ id: 'knowledge', name: 'Knowledge', reuse,
  review: { template_path: '90_System/Prompts/Review/Knowledge.md', execution: { ...defaultSettings, route: 'api', endpoint: 'http://127.0.0.1:8094/v1', model: 'fixture' } },
  relation: { template_path: '90_System/Prompts/Relation/Knowledge.md', execution: { ...defaultSettings, route: 'api', endpoint: 'http://127.0.0.1:8094/v1', model: 'fixture' } } });
export const emptyAnalysis = (task: 'review' | 'relation') => JSON.stringify(task === 'review' ? { summary: 'No findings.', findings: [] } : { summary: 'No relations.', suggestions: [] });
export async function analyzerFixture(executor?: AnalyzerExecutor): Promise<Awaited<ReturnType<typeof isolatedRuntime>> & {
  db: Database.Database; analyzer: AnalyzerJobs; request: () => AnalyzeRequest; recall: Pick<SemanticRecall, 'recall' | 'context'>;
  hit: RecallHit; sourcePath: string; draftPath: string; libraryPath: string; close(): Promise<void>;
}> {
  const runtime = await isolatedRuntime(); await mkdir(runtime.config.data_dir);
  const sourcePath = '20_Sources/material.md'; const draftPath = '30_Drafts/one.md'; const libraryPath = '40_Knowledge/library.md';
  await writeDocument(runtime.config.vault_path, sourcePath, manualSource('The effect holds only under condition A.', 'processing_status: compiled\nannotation: "My understanding is broader than the original."\ncustom: preserve-me\n'));
  await writeDocument(runtime.config.vault_path, draftPath, `---\ntype: draft\ntitle: Test Draft\nlifecycle_status: active\nsources: ["[[${sourcePath}]]"]\n---\nThe effect always holds.\n`);
  await writeDocument(runtime.config.vault_path, libraryPath, '---\ntitle: Scope\n---\nCondition A constrains the effect.\n');
  const library = await readMarkdown(runtime.config.vault_path, libraryPath);
  const coverage: RecallResponse['coverage'] = { state: 'idle', initialized: true, indexed_documents: 1, indexed_chunks: 1, eligible_documents: 1, stale_documents: 0, fingerprint: 'fixture', indexed_at: new Date().toISOString(), generation: 1, processed_documents: 1, embedded_chunks: 1, reused_chunks: 0, error: null, diagnostics: [] };
  const hit: RecallResponse['items'][number] = { chunk_id: 'selected-evidence', path: libraryPath, revision: library.revision, kind: 'knowledge', title: 'Scope', heading: '', text: 'Condition A constrains the effect.', start_line: 4, end_line: 4, score: 1, rerank_score: null, channels: ['bm25'] };
  const recall = { async recall(): Promise<RecallResponse> { return { items: [hit], coverage, diagnostics: [], reranker: 'disabled', timings: { total_ms: 0, embedding_ms: 0, retrieval_ms: 0, rerank_ms: 0 } }; },
    async context(items: { chunk_id: string }[]) { return { items: items.some(item => item.chunk_id === hit.chunk_id) ? [hit] : [], diagnostics: [], truncated: false }; } };
  const db = await openDatabase(runtime.config); await analysisTemplates(runtime.config.vault_path);
  const analyzer = new AnalyzerJobs(db, runtime.config, recall, () => false, executor);
  await analyzer.initialize(); await analyzer.settings.save({ default_profile: 'knowledge', profiles: [analysisProfile()] });
  const source = await readMarkdown(runtime.config.vault_path, sourcePath); const draft = await readMarkdown(runtime.config.vault_path, draftPath);
  const request = (): AnalyzeRequest => ({ request_id: randomUUID(), source_path: sourcePath, source_revision: source.revision, draft_path: draftPath, draft_revision: draft.revision });
  return { ...runtime, db, analyzer, request, recall, hit, sourcePath, draftPath, libraryPath,
    async close() { await analyzer.close(); db.close(); await runtime.cleanup(); } };
}
