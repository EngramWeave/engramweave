import Fastify, { type FastifyError } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { API, API_VERSION, CORE_VERSION, LIMITS, type Config, type Health } from '@engramweave/contracts';
import { CoreError } from './errors.js';
import type { CoreServices } from './http/context.js';
import { registerRegistryRoutes } from './http/registry.js';
import { registerDocumentRoutes } from './http/documents.js';
import { registerSearchRoute } from './http/search.js';
import { registerCaptureRoute } from './http/captures.js';
import { registerCompilerRoutes } from './http/compiler.js';
import { registerRecallRoutes } from './http/recall.js';
import { registerAnalysisRoutes } from './http/analysis.js';
import { registerReviewRoutes } from './http/review.js';
import { registerProcessingRoutes } from './http/processing.js';

export interface HttpRuntime {
  token: string | null;
  status: Health['status'];
}

export function createHttp(config: Config, runtime: HttpRuntime, services?: () => CoreServices) {
  const server = Fastify({
    logger: false,
    bodyLimit: LIMITS.capture_json_bytes,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });
  server.addHook('onRequest', async request => {
    if (request.headers.host !== `${config.host}:${config.port}`) {
      throw new CoreError('HOST_NOT_ALLOWED', 'Host does not match the configured loopback address', 403);
    }
    // Desktop uses a native bridge; no browser Origin is needed or granted CORS access.
    if (request.headers.origin !== undefined) throw new CoreError('ORIGIN_NOT_ALLOWED', 'Browser origins are not permitted', 403);
    if (request.method === 'GET' && request.url.split('?')[0] === '/v1/health') return;
    const supplied = request.headers.authorization;
    const expected = runtime.token === null ? null : `Bearer ${runtime.token}`;
    if (expected === null || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      throw new CoreError('UNAUTHORIZED', 'Local authentication is required', 401);
    }
  });
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof CoreError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    const failure = error as FastifyError;
    if (failure.validation) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request does not match the API schema', details: null } });
    if (failure.statusCode === 413) {
      // Fastify closes parser failures before a large upload finishes, which can reset
      // the client instead of delivering 413. Discard the rest without buffering it.
      reply.removeHeader('connection');
      request.raw.resume();
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request exceeds the size limit', details: null } });
    }
    if (failure.statusCode === 400 || failure.statusCode === 415) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON request', details: null } });
    return reply.code(500).send({ error: { code: 'IO_ERROR', message: 'Core operation failed', details: null } });
  });
  server.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'API route is unavailable', details: null } }));
  server.route({ ...API.health, async handler(_request, reply) {
    const health: Health = { status: runtime.status, core_version: CORE_VERSION, api_version: API_VERSION };
    return reply.code(runtime.status === 'ready' ? 200 : 503).send(health);
  } });
  if (services) {
    server.addHook('preHandler', async request => {
      const scheduleSettings = request.url === API.processingSettingsWrite.url;
      if (request.method === 'POST' && !scheduleSettings && services().processing?.busy() && request.url !== API.processingCancel.url && request.url !== API.processing.url && request.url !== API.captures.url) throw new CoreError('JOB_BUSY', 'A processing round owns the model workflow; wait or cancel that round', 409);
      if (request.method === 'POST' && !scheduleSettings && services().recompile?.busy() && request.url !== API.recompile.url) throw new CoreError('JOB_BUSY', 'Finish or recover the Recompile action before another mutation', 409);
      if (request.method === 'POST' && !scheduleSettings && request.url !== API.publishDraft.url && services().publications?.busy()) {
        throw new CoreError('JOB_BUSY', 'Finish or recover the approved Draft publication before another mutation', 409);
      }
    });
    registerRegistryRoutes(server, config, services);
    registerDocumentRoutes(server, config, services);
    registerSearchRoute(server, services);
    registerCaptureRoute(server, config, runtime, services);
    registerCompilerRoutes(server, config, services);
    registerRecallRoutes(server, services);
    registerAnalysisRoutes(server, config, services);
    registerReviewRoutes(server, config, services);
    registerProcessingRoutes(server, services);
  }
  return server;
}
