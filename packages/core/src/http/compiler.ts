import type { FastifyInstance } from 'fastify';
import { API, type CompileRequest, type CompilerSettings, type Config, type SourceBatchRequest } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readDraft, listDrafts } from '../drafts/files.js';
import type { CoreServices } from './context.js';
import { loadCompilerTemplate } from '../compiler/template.js';

export function registerCompilerRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  const compiler = () => {
    const value = services().compiler;
    if (!value) throw new CoreError('CORE_UNAVAILABLE', 'Compiler service is unavailable', 503);
    return value;
  };
  server.route({ ...API.compilerSettings, async handler() { await loadCompilerTemplate(config.vault_path); return compiler().settings.read(); } });
  server.route({ ...API.compilerSettingsWrite, handler(request) {
    const input = request.body as { settings: CompilerSettings; api_key?: string };
    return compiler().settings.save(input.settings, input.api_key);
  } });
  server.route({ ...API.compile, async handler(request, reply) { if (services().batches?.busy()) throw new CoreError('JOB_BUSY', 'A Source batch is active', 409); return reply.code(202).send(await compiler().submit(request.body as CompileRequest)); } });
  server.route({ ...API.drafts, handler(request) { return listDrafts(config.vault_path, (request.query as { source_path: string }).source_path); } });
  server.route({ ...API.draft, handler(request) { return readDraft(config.vault_path, (request.query as { path: string }).path); } });
  server.route({ ...API.sourceBatch, async handler(request, reply) { return reply.code(202).send(await services().batches!.submit(request.body as SourceBatchRequest)); } });
  server.route({ ...API.sourceBatchStatus, handler(request) { return services().batches!.get((request.query as { id: string }).id); } });
  server.route({ ...API.discardPreview, handler(request) { return services().batches!.preview((request.query as { path: string }).path); } });
}
