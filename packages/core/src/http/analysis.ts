import type { FastifyInstance } from 'fastify';
import { API, type AnalyzeRequest, type AnalysisSettings, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import type { CoreServices } from './context.js';
import { analysisTemplates, loadAnalysisTemplate, saveAnalysisTemplate } from '../analysis/templates.js';
import { writeAnalysisSelection } from '../analysis/selection.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown } from '../source/parse.js';
import { updateCompiledSource } from '../storage/registry.js';

export function registerAnalysisRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  const analyzer = () => { const value = services().analyzer; if (!value) throw new CoreError('CORE_UNAVAILABLE', 'Analyzer is unavailable', 503); return value; };
  server.route({ ...API.analysisSettings, handler() { return analyzer().settings.read(); } });
  server.route({ ...API.analysisSettingsWrite, async handler(request) {
    const input = request.body as { settings: AnalysisSettings; credentials?: { profile_id: string; task: 'review' | 'relation'; api_key: string }[] };
    for (const profile of input.settings.profiles) for (const task of ['review','relation'] as const) await loadAnalysisTemplate(config.vault_path, profile[task].template_path);
    return analyzer().settings.save(input.settings, input.credentials);
  } });
  server.route({ ...API.analysisTemplates, handler() { return analysisTemplates(config.vault_path); } });
  server.route({ ...API.analysisTemplateWrite, handler(request) { return saveAnalysisTemplate(config.vault_path, request.body as { path: string; revision: string; content: string }); } });
  server.route({ ...API.analysisSelection, async handler(request) {
    const input = request.body as { path: string; revision: string; profile_id: string };
    if (services().jobs.active() || services().batches?.busy() || services().compiler?.busy() || analyzer().sourceBusy(input.path)) throw new CoreError('JOB_BUSY', 'A conflicting Source operation is active', 409);
    await analyzer().settings.select(input.profile_id);
    const result = await writeAnalysisSelection(config.vault_path, input);
    const file = await readMarkdown(config.vault_path, input.path);
    updateCompiledSource(services().db, input.path, file, parseMarkdown(input.path, file.bytes));
    return result;
  } });
  server.route({ ...API.analyze, async handler(request, reply) { return reply.code(202).send(await analyzer().submit(request.body as AnalyzeRequest)); } });
  server.route({ ...API.analysisCancel, handler(request) { return analyzer().cancel((request.body as { id: string }).id); } });
  server.route({ ...API.analysisResult, handler(request) { return analyzer().result((request.query as { id: string }).id); } });
}
