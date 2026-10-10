import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { DraftReview, HumanReviewRequest, RecompileRequest } from '@engramweave/contracts';
import { isolatedRuntime } from '../helpers/runtime.js';
import { recoverCore, standaloneCore } from '../helpers/cli.js';
import { assetHashes } from '../helpers/recovery.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { analysisProfile } from '../helpers/analyzer.js';
import { defaultRecallSettings } from '../../packages/core/src/recall/settings.js';
import { waitSemanticIndex } from '../helpers/recall.js';

it.each(['missing', 'corrupt'] as const)('recovers P2 user input and revoked permissions through the offline CLI and a standalone restart after %s databases', async scenario => {
  let modelCalls = 0;
  const provider = createServer(async (req, res) => {
    modelCalls++; const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      const body = JSON.parse(Buffer.concat(parts).toString());
      res.end(JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0, 0] })) }));
    } else { res.statusCode = 503; res.end('{}'); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const f = await isolatedRuntime(); let core: Awaited<ReturnType<typeof standaloneCore>> | undefined;
  const source = (name: string) => `20_Sources/${name}.md`;
  const draft = (name: string) => `30_Drafts/${name}.md`;
  try {
    for (const name of ['selected','cancelled','feedback']) {
      await writeDocument(f.config.vault_path, source(name), manualSource(`User material ${name}`, 'processing_status: compiled\nlifecycle_status: active\nannotation: "Original user context"\n'));
      await writeDocument(f.config.vault_path, draft(name), `---\ntype: draft\ntitle: User Draft\nlifecycle_status: active\nsources: ["[[${source(name)}]]"]\ncaptured_at: "2026-10-10"\nannotation: "Original user context"\n---\nHuman edits ${name}.\n`);
    }
    await writeDocument(f.config.vault_path, draft('second'), (await readFile(path.join(f.config.vault_path, draft('selected')), 'utf8')) + '\nSecond independent user edit.\n');
    await writeDocument(f.config.vault_path, '40_Knowledge/related.md', '# Local evidence\nOriginal material remains authoritative.');
    core = await standaloneCore(f.root, f.config);
    const api = async <T = Record<string, unknown>>(route: string, body?: unknown): Promise<T> => {
      const response = await core!.request(route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBeLessThan(300); return value as T;
    };
    const context = (name: string) => api<DraftReview>(`/v1/draft-review?path=${draft(name)}`);
    const input = async (name: string, action: HumanReviewRequest['action'], note: string): Promise<HumanReviewRequest> => {
      const c = await context(name); return { request_id: randomUUID(), source_path: c.source.path, source_revision: c.source.revision, draft_path: c.draft.path, draft_revision: c.draft.revision, action, note };
    };
    await finishedJob(core.request, (await submitScan(core.request)).job.id);
    await api('/v1/recall/settings', { settings: { ...defaultRecallSettings, endpoint, model: 'isolated' } });
    await api('/v1/recall/index', { mode: 'build' }); expect((await waitSemanticIndex(core.request)).initialized).toBe(true);
    await api('/v1/analysis/templates');
    const profile = analysisProfile(); for (const task of ['review','relation'] as const) profile[task].execution = { ...profile[task].execution, endpoint, timeout_seconds: 10 };
    await api('/v1/analysis/settings', { settings: { default_profile: profile.id, profiles: [profile] } });
    const original = await input('selected', 'complete', 'Intent A'); await api('/v1/human-review', original);
    const selected = await input('second', 'complete', 'Intent B'); await api('/v1/human-review', selected);
    const cancelled = await input('cancelled', 'complete', 'Keep cancelled Intent'); await api('/v1/human-review', cancelled);
    await api('/v1/human-review', await input('cancelled', 'cancel', ''));
    await api('/v1/human-review', await input('feedback', 'complete', 'Keep feedback Intent'));
    const { action: _action, note: _note, ...identity } = await input('feedback', 'complete', '');
    const recompile: RecompileRequest = { ...identity, feedback: 'Append this exact feedback once.' }; await api('/v1/recompile', recompile);
    const idea = await input('second', 'idea', 'Exact human Idea with Source and Draft provenance.'); await api('/v1/human-review', idea);
    const c = await context('second'); const analysisId = randomUUID();
    await api('/v1/analyses', { request_id: analysisId, source_path: c.source.path, source_revision: c.source.revision, draft_path: c.draft.path, draft_revision: c.draft.revision });
    expect((await finishedJob(core.request, analysisId)).status).toBe('failed');
    const before = await Promise.all(['selected','second','cancelled','feedback'].map(context));
    const hashes = await assetHashes(f.config.vault_path); const calls = modelCalls;
    await core.close(); core = undefined;
    const database = path.join(f.config.data_dir, 'core.sqlite');
    const semantic = path.join(f.config.data_dir, 'semantic.sqlite');
    if (scenario === 'missing') { await rm(database); await rm(semantic); }
    else { await writeFile(database, 'Broken Core SQLite'); await writeFile(semantic, 'Broken semantic SQLite'); }
    const recovery = (await recoverCore(f.root, f.config)).result;
    expect(recovery.job.status).toBe('succeeded');
    if (scenario === 'corrupt') expect(await readFile(path.join(recovery.backup_dir, 'core.sqlite'), 'utf8')).toBe('Broken Core SQLite');
    core = await standaloneCore(f.root, f.config);
    const after = await Promise.all(['selected','second','cancelled','feedback'].map(context));
    expect(after.map(item => item.human_review)).toEqual(before.map(item => item.human_review));
    expect(after.map(item => item.source.kind === 'source' ? item.source.processing_status : null)).toEqual(['reviewed','reviewed','compiled','pending']);
    expect(after[1]!.human_review).toEqual({ selected_draft: draft('second'), intent: 'Intent B' });
    expect(after[2]!.human_review).toEqual({ selected_draft: null, intent: 'Keep cancelled Intent' });
    expect(after[3]!.human_review).toEqual({ selected_draft: null, intent: 'Keep feedback Intent' });
    expect((await api<{ items: { path: string; recompile_count: number }[] }>('/v1/sources?view=pending')).items.find(item => item.path === source('feedback'))?.recompile_count).toBe(1);
    expect(await api(`/v1/review-action?id=${original.request_id}`)).toMatchObject({ status: 'completed', request: original });
    expect(await api(`/v1/analysis/result?id=${analysisId}`)).toMatchObject({ job: { status: 'failed' } });
    expect(await api('/v1/recall/status')).toMatchObject({ initialized: false, state: 'not_built' });
    await api('/v1/human-review', original); await api('/v1/human-review', cancelled); await api('/v1/human-review', idea); await api('/v1/recompile', recompile);
    expect((await context('selected')).human_review!.selected_draft).toBe(draft('second'));
    expect((await context('cancelled')).human_review!.selected_draft).toBeNull();
    expect(await assetHashes(f.config.vault_path)).toEqual(hashes);
    expect(modelCalls).toBe(calls);
  } finally { await core?.close(); await f.cleanup(); await new Promise<void>(resolve => provider.close(() => resolve())); }
}, 90000);
