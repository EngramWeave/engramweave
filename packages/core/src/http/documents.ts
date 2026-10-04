import type { FastifyInstance } from 'fastify';
import { API, type Config, type Document } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readMarkdown, FileProblem } from '../files/read.js';
import { parseMarkdown, stringList } from '../source/parse.js';
import { getDocument } from '../storage/registry.js';
import { indexMeta } from '../storage/database.js';
import type { CoreServices } from './context.js';

export function registerDocumentRoutes(server: FastifyInstance, config: Config, services: () => CoreServices) {
  server.route({ ...API.documents, async handler(request) {
    const { db } = services();
    const relative = (request.query as { path: string }).path;
    let file;
    try { file = await readMarkdown(config.vault_path, relative); }
    catch (error) {
      if (error instanceof FileProblem) throw new CoreError('INVALID_SOURCE', error.message, 422, { diagnostic_code: error.code });
      throw error;
    }
    const parsed = parseMarkdown(relative, file.bytes);
    if (parsed.state !== 'ready') throw new CoreError('INVALID_SOURCE', 'Current document is not valid for this scope', 422, { diagnostics: parsed.diagnostics });
    const row = getDocument(db, relative); const meta = indexMeta(db);
    const common = { path: relative, revision: file.revision, indexed_revision: row?.revision ?? null,
      indexed_at: row?.indexed_at ?? null, index_generation: meta.index_generation,
      index_stale: !row || row.state !== 'ready' || row.revision !== file.revision,
      title: parsed.title, metadata: parsed.metadata, annotation: parsed.annotation, diagnostics: parsed.diagnostics,
      original_references: (parsed.kind === 'knowledge' ? stringList(parsed.metadata.sources) : [parsed.original_locator, typeof parsed.metadata.asset === 'string' ? parsed.metadata.asset : null].filter((value): value is string => value !== null))
        .map(raw => ({ raw, target_path: null, anchor: null, alias: null, availability: /^(?:https?|zotero):/i.test(raw) ? 'unverified' as const : 'unsupported' as const })),
    };
    if (parsed.kind === 'knowledge') {
      const document: Document = { ...common, kind: 'knowledge', record_path: null, source_type: null, original_locator: null,
        captured_at: null, asset: null, source_content: null, record_body: null, body: parsed.body_markdown };
      return document;
    }
    const source = { ...common, kind: 'source' as const, record_path: relative, source_type: parsed.source_type!,
      original_locator: parsed.original_locator, captured_at: parsed.captured_at, processing_status: parsed.processing_status, body: null };
    const asset = parsed.asset!;
    if (asset.kind === 'inline_markdown') {
      const document: Document = { ...source, asset: { ...asset, kind: 'inline_markdown' }, source_content: parsed.body_markdown, record_body: null };
      return document;
    }
    const document: Document = { ...source, asset: { ...asset, kind: asset.kind }, source_content: null, record_body: parsed.body_markdown };
    return document;
  } });
}
