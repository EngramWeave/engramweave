import Fastify, { type FastifyError } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { API, API_VERSION, CORE_VERSION, LIMITS, type Config, type Health } from '@engramweave/contracts';
import { CoreError } from './errors.js';
import type { CoreServices } from './http/context.js';
import { registerRegistryRoutes } from './http/registry.js';
import { registerDocumentRoutes } from './http/documents.js';
import { registerSearchRoute } from './http/search.js';
import { registerCaptureRoute } from './http/captures.js';

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
    registerRegistryRoutes(server, config, services);
    registerDocumentRoutes(server, config, services);
    registerSearchRoute(server, services);
    registerCaptureRoute(server, config, runtime);
  }
  return server;
}
