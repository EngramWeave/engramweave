import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { API, API_VERSION, CORE_VERSION, LIMITS, SCAN_ROOTS, type Config, type PaginationQuery, type ScanRequest, type SourcesQuery, type Status } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { documentPathKey, normalizeVaultPath } from '../files/paths.js';
import { indexMeta } from '../storage/database.js';
import { sourceItem, type DocumentRow } from '../storage/registry.js';
import type { CoreServices } from './context.js';
import { querySources, sourceViews } from '../storage/source-views.js';
import { stringList } from '../source/parse.js';

export const pagination = (query: PaginationQuery) => ({ limit: query.limit ?? LIMITS.default_limit, offset: query.offset ?? 0 });
export function inPathPrefix(relative: string, prefix: string): boolean {
  const key = documentPathKey(relative); const prefixKey = documentPathKey(normalizeVaultPath(prefix));
  return key === prefixKey || key.startsWith(`${prefixKey}/`);
}

export function registerRegistryRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  server.route({ ...API.scans, handler(request, reply) { return reply.code(202).send(services().jobs.submit((request.body as ScanRequest).mode)); } });
  server.route({ ...API.jobs, handler(request) {
    const { limit, offset } = pagination(request.query as PaginationQuery);
    const { jobs, compiler } = services();
    const scans = jobs.list(Number.MAX_SAFE_INTEGER, 0);
    const items = [...scans.items, ...(compiler?.all() ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  } });
  server.route({ ...API.job, handler(request) {
    const id = (request.params as { id: string }).id;
    const job = services().jobs.get(id) ?? services().compiler?.get(id);
    if (!job) throw new CoreError('JOB_NOT_FOUND', 'Job does not exist', 404);
    return job;
  } });
  server.route({ ...API.sources, handler(request) {
    const { db } = services();
    const query = request.query as SourcesQuery;
    const { limit, offset } = pagination(query);
    // Browsing without text search does not copy every Source body out of SQLite.
    const textFields = ['annotation', 'body_markdown', 'title_norm', 'body_norm', 'annotation_norm', 'metadata_norm'];
    const fields = 'id,path_key,path,kind,state,revision,size,mtime,title,source_type,captured_at,original_locator,metadata_json,asset_json,diagnostics_json,indexed_at,' + textFields.map(field => query.q?.trim() ? field : `'' AS ${field}`).join(',');
    const all = db.prepare(`SELECT ${fields} FROM documents WHERE kind='source' ORDER BY path_key`).all() as DocumentRow[];
    let rows = querySources(all, query);
    if (query.path_prefix !== undefined) rows = rows.filter(row => inPathPrefix(row.path, query.path_prefix!));
    const meta = indexMeta(db);
    return { items: rows.slice(offset, offset + limit).map(sourceItem), total: rows.length, limit, offset, index_generation: meta.index_generation, indexed_at: meta.last_scan_at,
      views: sourceViews(all), facets: { types: [...new Set(all.map(row => row.source_type).filter((type): type is string => type !== null))].sort(), tags: [...new Set(all.flatMap(row => stringList(JSON.parse(row.metadata_json).tags)))].sort() } };
  } });
  server.route({ ...API.status, async handler() {
    const { db, jobs, instance_id } = services(); const meta = indexMeta(db);
    const rows = db.prepare(`SELECT kind,state,count(*) AS count,
      sum(CASE WHEN kind='source' AND json_extract(metadata_json,'$.processing_status')='pending'
        AND coalesce(json_extract(metadata_json,'$.lifecycle_status'),'') <> 'discarded' THEN 1 ELSE 0 END) AS pending
      FROM documents GROUP BY kind,state`).all() as { kind: string; state: string; count: number; pending: number }[];
    const counts = { sources: 0, knowledge: 0, invalid: 0, missing: 0, unsupported: 0, pending: 0 };
    for (const row of rows) {
      counts.pending += row.pending;
      if (row.state === 'ready') counts[row.kind === 'source' ? 'sources' : 'knowledge'] += row.count;
      else counts[row.state as 'invalid' | 'missing' | 'unsupported'] += row.count;
    }
    const roots = await Promise.all(SCAN_ROOTS.map(async root => {
      try { const info = await lstat(path.join(config.vault_path, root)); return { path: root, available: info.isDirectory() && !info.isSymbolicLink() }; }
      catch { return { path: root, available: false }; }
    }));
    const status: Status = { status: 'ready', core_version: CORE_VERSION, api_version: API_VERSION, instance_id,
      vault_path: config.vault_path, data_dir: config.data_dir, database_initialized: true, active_job: jobs.active() ?? services().compiler?.active() ?? null,
      index_generation: meta.index_generation, last_scan_at: meta.last_scan_at, counts, scan_roots: roots, limits: LIMITS, source_batch: services().batches?.latest() ?? null,
      diagnostics: roots.filter(root => !root.available).map(root => ({ code: 'SCAN_ROOT_UNAVAILABLE', message: 'Scan root is currently absent or unavailable', path: root.path })) };
    return status;
  } });
}
