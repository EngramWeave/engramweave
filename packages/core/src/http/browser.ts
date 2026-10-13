import type { FastifyInstance } from 'fastify';
import { RESOURCE_API, type Config, type ReviewBrowserQuery, type ChangeBrowserQuery } from '@engramweave/contracts';
import type { CoreServices } from './context.js';
import { reviewFiles } from '../drafts/browser.js';
import { changeFiles } from '../changesets/browser.js';
import { readMarkdown } from '../files/read.js';
import { CoreError } from '../errors.js';

export function registerBrowserRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  server.route({ ...RESOURCE_API.review, handler: request => reviewFiles(config, services(), request.query as ReviewBrowserQuery) });
  server.route({ ...RESOURCE_API.changes, handler: request => changeFiles(config, services(), request.query as ChangeBrowserQuery) });
  server.route({ ...RESOURCE_API.overview, async handler(request) {
    const { id } = request.query as { id: string }; const current = services();
    if (!current.planner) throw new CoreError('CORE_UNAVAILABLE', 'Planner is unavailable', 503);
    const { manifest } = await current.planner.changesets.read(id);
    return { manifest, review: current.integration?.owns(id) || manifest.state !== 'ready' ? null : await current.integration?.reviews.read(id) ?? null };
  } });
  server.route({ ...RESOURCE_API.draftFile, async handler(request) {
    const { path } = request.query as { path: string };
    if (!path.startsWith('30_Drafts/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Only Draft files can be opened through this endpoint', 403);
    const file = await readMarkdown(config.vault_path, path);
    return { path, revision: file.revision };
  } });
}
