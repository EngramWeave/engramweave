import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { API, API_VERSION, CORE_VERSION, LIMITS, SCAN_ROOTS, type Config, type PaginationQuery, type ScanRequest, type SourcesQuery, type Status } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { documentPathKey, normalizeVaultPath } from '../files/paths.js';
import { indexMeta } from '../storage/database.js';
import { sourceItem, type DocumentRow } from '../storage/registry.js';
import type { CoreServices } from './context.js';

export const pagination = (query: PaginationQuery) => ({ limit: query.limit ?? LIMITS.default_limit, offset: query.offset ?? 0 });
export function inPathPrefix(relative: string, prefix: string): boolean {
  const key = documentPathKey(relative); const prefixKey = documentPathKey(normalizeVaultPath(prefix));
  return key === prefixKey || key.startsWith(`${prefixKey}/`);
}

export function registerRegistryRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  server.route({ ...API.scans, handler(request, reply) { return reply.code(202).send(services().jobs.submit((request.body as ScanRequest).mode)); } });
  server.route({ ...API.jobs, handler(request) { const { limit, offset } = pagination(request.query as PaginationQuery); return services().jobs.list(limit, offset); } });
  server.route({ ...API.job, handler(request) {
    const job = services().jobs.get((request.params as { id: string }).id);
    if (!job) throw new CoreError('JOB_NOT_FOUND', 'Job does not exist', 404);
    return job;
  } });
  server.route({ ...API.sources, handler(request) {
    const { db } = services();
    const query = request.query as SourcesQuery;
    const { limit, offset } = pagination(query);
    let rows = db.prepare("SELECT id,path_key,path,title,source_type,state,revision,original_locator,captured_at,asset_json,diagnostics_json FROM documents WHERE kind='source' AND state=? AND (? IS NULL OR source_type=?) ORDER BY path_key")
      .all(query.state ?? 'ready', query.source_type ?? null, query.source_type ?? null) as DocumentRow[];
    if (query.path_prefix !== undefined) rows = rows.filter(row => inPathPrefix(row.path, query.path_prefix!));
    const meta = indexMeta(db);
    return { items: rows.slice(offset, offset + limit).map(sourceItem), total: rows.length, limit, offset, index_generation: meta.index_generation, indexed_at: meta.last_scan_at };
  } });
  server.route({ ...API.status, async handler() {
    const { db, jobs, instance_id } = services(); const meta = indexMeta(db);
    const rows = db.prepare('SELECT kind,state,count(*) AS count FROM documents GROUP BY kind,state').all() as { kind: string; state: string; count: number }[];
    const counts = { sources: 0, knowledge: 0, invalid: 0, missing: 0, unsupported: 0 };
    for (const row of rows) {
      if (row.state === 'ready') counts[row.kind === 'source' ? 'sources' : 'knowledge'] += row.count;
      else counts[row.state as 'invalid' | 'missing' | 'unsupported'] += row.count;
    }
    const roots = await Promise.all(SCAN_ROOTS.map(async root => {
      try { const info = await lstat(path.join(config.vault_path, root)); return { path: root, available: info.isDirectory() && !info.isSymbolicLink() }; }
      catch { return { path: root, available: false }; }
    }));
    const status: Status = { status: 'ready', core_version: CORE_VERSION, api_version: API_VERSION, instance_id,
      vault_path: config.vault_path, data_dir: config.data_dir, database_initialized: true, active_job: jobs.active(),
      index_generation: meta.index_generation, last_scan_at: meta.last_scan_at, counts, scan_roots: roots, limits: LIMITS,
      diagnostics: roots.filter(root => !root.available).map(root => ({ code: 'SCAN_ROOT_UNAVAILABLE', message: 'Scan root is currently absent or unavailable', path: root.path })) };
    return status;
  } });
}
