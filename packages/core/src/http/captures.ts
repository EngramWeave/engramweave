import type { FastifyInstance } from 'fastify';
import { API, type CaptureRequest, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { createCapture } from '../capture/create.js';
import type { HttpRuntime } from '../http.js';

export function registerCaptureRoute(server: FastifyInstance, config: Config, runtime: HttpRuntime) {
  server.route({ ...API.captures,
    async preValidation(request) {
      const body = request.body as Partial<CaptureRequest> | null;
      if (!body || typeof body.path !== 'string' || typeof body.markdown !== 'string') throw new CoreError('VALIDATION_ERROR', 'Capture fields must be strings', 400);
    },
    async handler(request, reply) {
      if (runtime.status !== 'ready') throw new CoreError('CORE_UNAVAILABLE', 'Core is not ready for Capture', 503);
      // Authentication and file validation suffice; no SQLite call belongs in saving an asset.
      const result = await createCapture(config.vault_path, request.body as CaptureRequest);
      return reply.code(result.created ? 201 : 200).send(result);
    },
  });
}
