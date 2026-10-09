import type { FastifyInstance } from 'fastify';
import { API, type ProcessingRequest, type ProcessingSettings, type RecompileRequest } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import type { CoreServices } from './context.js';

export function registerProcessingRoutes(server: FastifyInstance, services: () => CoreServices) {
  const rounds = () => { const value = services().processing; if (!value) throw new CoreError('CORE_UNAVAILABLE', 'Processing is unavailable', 503); return value; };
  const settings = () => { const value = services().processingSettings; if (!value) throw new CoreError('CORE_UNAVAILABLE','Processing settings are unavailable',503);return value; };
  server.route({ ...API.processingSettings, handler() { return settings().read(); } });
  server.route({ ...API.processingSettingsWrite, async handler(request) { const result = await settings().save(request.body as ProcessingSettings); services().scheduler?.reset(); return result; } });
  server.route({ ...API.processingState, handler() { return { schedule: services().scheduler!.read(), active: rounds().active(), latest: rounds().list(1,0).items[0] ?? null }; } });
  server.route({ ...API.processing, async handler(request, reply) { return reply.code(202).send(await rounds().submit(request.body as ProcessingRequest)); } });
  server.route({ ...API.processingRounds, handler(request) { const query = request.query as { limit?: number; offset?: number }; return rounds().list(query.limit, query.offset); } });
  server.route({ ...API.processingRound, handler(request) { const round = rounds().get((request.query as { id: string }).id); if (!round) throw new CoreError('JOB_NOT_FOUND', 'Processing round not found', 404); return round; } });
  server.route({ ...API.processingCancel, handler(request) { return rounds().cancel((request.body as { id: string }).id); } });
  server.route({ ...API.recompile, handler(request) { const service = services().recompile; if (!service) throw new CoreError('CORE_UNAVAILABLE', 'Recompile is unavailable', 503); return service.submit(request.body as RecompileRequest); } });
}
