import type { FastifyInstance } from 'fastify';
import { API, type Config, type DraftReview, type PublishDraftRequest } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readDraft } from '../drafts/files.js';
import { sourceRelations } from '../storage/source-relations.js';
import { readDocument } from './documents.js';
import type { CoreServices } from './context.js';

export function registerReviewRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  server.route({ ...API.draftReview, async handler(request): Promise<DraftReview> {
    const draft = await readDraft(config.vault_path, (request.query as { path: string }).path);
    if (draft.sources.length !== 1) throw new CoreError('INVALID_SOURCE', 'MVP review supports a Draft from one Source', 422);
    const current = services();
    const source = await readDocument(config, current, draft.sources[0]!);
    const index = sourceRelations(current.db, config.vault_path); await index.refresh(true);
    const targets = index.targets(source.path);
    const analysis = current.analyzer?.latestForDraft(draft.path) ?? null;
    return { draft, source, related_drafts: targets.drafts, diagnostics: targets.diagnostics, analysis,
      analyses: { review: current.analyzer?.latestForDraft(draft.path, 'review') ?? null, relation: current.analyzer?.latestForDraft(draft.path, 'relation') ?? null },
      publication: await current.publications?.forDraft(draft.path) ?? null };
  } });
  server.route({ ...API.publishDraft, handler(request) {
    const service = services().publications;
    if (!service) throw new CoreError('CORE_UNAVAILABLE', 'Draft publication is unavailable', 503);
    return service.submit(request.body as PublishDraftRequest);
  } });
}
