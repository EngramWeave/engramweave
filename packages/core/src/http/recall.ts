import type { FastifyInstance } from 'fastify';
import { API, type RecallQuery, type RecallSettings } from '@engramweave/contracts';
import type { CoreServices } from './context.js';
import { CoreError } from '../errors.js';
export function registerRecallRoutes(server: FastifyInstance, services: () => CoreServices) {
  const recall = () => { const value = services().recall; if (!value) throw new CoreError('CORE_UNAVAILABLE', 'Semantic recall is unavailable', 503); return value; };
  server.route({ ...API.recallSettings, handler: () => recall().settings.read() });
  server.route({ ...API.recallSettingsWrite, handler(request) { const input = request.body as { settings: RecallSettings; api_key?: string; reranker_key?: string }; return recall().settings.save(input.settings, input.api_key, input.reranker_key); } });
  server.route({ ...API.recallTest, handler: () => recall().test() });
  server.route({ ...API.recallStatus, handler: () => recall().status() });
  server.route({ ...API.recallIndex, async handler(request, reply) {
    if (services().jobs.active()) throw new CoreError('JOB_BUSY', 'Wait for local registration to finish before indexing', 409);
    return reply.code(202).send(await recall().submit((request.body as { mode: 'build' | 'update' | 'rebuild' }).mode));
  } });
  server.route({ ...API.recall, handler: request => recall().recall(request.body as RecallQuery) });
  server.route({ ...API.recallContext, handler: request => recall().context((request.body as { items: { path: string; revision: string; chunk_id: string }[] }).items) });
}
