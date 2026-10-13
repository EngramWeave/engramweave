import type { FastifyInstance } from 'fastify';
import { PLANNING_API, type PlannerSettings, type PlanRequest, type CandidateSave, type ChangeSetReview, type ChangeSetApproval } from '@engramweave/contracts';
import type { CoreServices } from './context.js';
import { CoreError } from '../errors.js';

export function registerPlanningRoutes(server: FastifyInstance, services: () => CoreServices) {
  const integration = () => { const service = services().integration; if (!service) throw new CoreError('CORE_UNAVAILABLE', 'Integration execution is unavailable', 503); return service; };
  const planner = () => { const service = services().planner; if (!service) throw new CoreError('CORE_UNAVAILABLE', 'Planner is unavailable', 503); return service; };
  server.route({ ...PLANNING_API.settings, handler: () => ({ settings: planner().settings.read() }) });
  server.route({ ...PLANNING_API.settingsWrite, async handler(request) { return { settings: await planner().settings.save((request.body as { settings: PlannerSettings }).settings) }; } });
  server.route({ ...PLANNING_API.template, handler: () => planner().settings.template() });
  server.route({ ...PLANNING_API.templateWrite, handler: request => planner().settings.saveTemplate(request.body as { content: string; revision: string }) });
  server.route({ ...PLANNING_API.plan, async handler(request, reply) { return reply.code(202).send(await planner().submit(request.body as PlanRequest)); } });
  server.route({ ...PLANNING_API.planCancel, handler: request => planner().cancel((request.body as { id: string }).id) });
  server.route({ ...PLANNING_API.changesets, async handler(request) { const { source_path } = request.query as { source_path?: string }; return { items: source_path ? await planner().readyForSource(source_path) : await planner().changesets.list() }; } });
  server.route({ ...PLANNING_API.changeset, handler: request => planner().changesets.read((request.query as { id: string }).id) });
  server.route({ ...PLANNING_API.candidate, handler: request => { const query = request.query as { id: string; item_id: string }; return planner().changesets.candidate(query.id, query.item_id); } });
  server.route({ ...PLANNING_API.candidateSave, handler: request => { const input = request.body as CandidateSave; services().integration?.guard(input.changeset_id); return planner().changesets.save(input); } });
  server.route({ ...PLANNING_API.review, handler: request => integration().reviews.inspect((request.query as { id: string }).id) });
  server.route({ ...PLANNING_API.reviewSave, handler: request => integration().reviews.save(request.body as ChangeSetReview) });
  server.route({ ...PLANNING_API.approve, handler: request => integration().approve(request.body as ChangeSetApproval) });
  server.route({ ...PLANNING_API.execution, handler: request => integration().lookup((request.query as { id: string }).id) });
  server.route({ ...PLANNING_API.integrationFile, handler: request => { const input = request.query as { id: string; path: string }; return integration().file(input.id, input.path); } });
  server.route({ ...PLANNING_API.changesetCancel, handler: request => planner().cancelChangeSet((request.body as { id: string }).id) });
}
