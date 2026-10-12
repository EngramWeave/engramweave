import type { FastifyInstance } from 'fastify';
import { PLANNING_API, type PlannerSettings, type PlanRequest, type CandidateSave } from '@engramweave/contracts';
import type { CoreServices } from './context.js';
import { CoreError } from '../errors.js';

export function registerPlanningRoutes(server: FastifyInstance, services: () => CoreServices) {
  const planner = () => { const service = services().planner; if (!service) throw new CoreError('CORE_UNAVAILABLE', 'Planner is unavailable', 503); return service; };
  server.route({ ...PLANNING_API.settings, handler: () => ({ settings: planner().settings.read() }) });
  server.route({ ...PLANNING_API.settingsWrite, async handler(request) { return { settings: await planner().settings.save((request.body as { settings: PlannerSettings }).settings) }; } });
  server.route({ ...PLANNING_API.template, handler: () => planner().settings.template() });
  server.route({ ...PLANNING_API.templateWrite, handler: request => planner().settings.saveTemplate(request.body as { content: string; revision: string }) });
  server.route({ ...PLANNING_API.plan, async handler(request, reply) { return reply.code(202).send(await planner().submit(request.body as PlanRequest)); } });
  server.route({ ...PLANNING_API.planCancel, handler: request => planner().cancel((request.body as { id: string }).id) });
  server.route({ ...PLANNING_API.changesets, async handler(request) { return { items: await planner().changesets.list((request.query as { source_path?: string }).source_path) }; } });
  server.route({ ...PLANNING_API.changeset, handler: request => planner().changesets.read((request.query as { id: string }).id) });
  server.route({ ...PLANNING_API.candidate, handler: request => { const query = request.query as { id: string; item_id: string }; return planner().changesets.candidate(query.id, query.item_id); } });
  server.route({ ...PLANNING_API.candidateSave, handler: request => planner().changesets.save(request.body as CandidateSave) });
  server.route({ ...PLANNING_API.changesetCancel, handler: request => planner().cancelChangeSet((request.body as { id: string }).id) });
}
