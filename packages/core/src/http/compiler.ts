import type { FastifyInstance } from 'fastify';
import { API, type CompileRequest, type CompilerSettings, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readDraft, listDrafts } from '../drafts/files.js';
import type { CoreServices } from './context.js';

export function registerCompilerRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  const compiler = () => {
    const value = services().compiler;
    if (!value) throw new CoreError('CORE_UNAVAILABLE', 'Compiler service is unavailable', 503);
    return value;
  };
  server.route({ ...API.compilerSettings, handler() { return compiler().settings.read(); } });
  server.route({ ...API.compilerSettingsWrite, handler(request) {
    const input = request.body as { settings: CompilerSettings; api_key?: string };
    return compiler().settings.save(input.settings, input.api_key);
  } });
  server.route({ ...API.compile, async handler(request, reply) { return reply.code(202).send(await compiler().submit(request.body as CompileRequest)); } });
  server.route({ ...API.drafts, handler(request) { return listDrafts(config.vault_path, (request.query as { source_path: string }).source_path); } });
  server.route({ ...API.draft, handler(request) { return readDraft(config.vault_path, (request.query as { path: string }).path); } });
}
