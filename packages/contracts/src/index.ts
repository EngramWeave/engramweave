import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const API_VERSION = '1';
export const CORE_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export const LIMITS = Object.freeze({
  markdown_bytes: 5 * 1024 * 1024,
  capture_json_bytes: 8 * 1024 * 1024,
  scan_candidates: 10_000,
  scan_total_bytes: 100 * 1024 * 1024,
  yaml_aliases: 50,
  query_characters: 200,
  query_terms: 8,
  snippet_characters: 240,
  default_limit: 20,
  max_limit: 100,
  retained_finished_jobs: 100,
});
export const SCAN_ROOTS = ['20_Sources', '40_Knowledge'] as const;
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const enumeration = <T extends string>(values: readonly T[]) => Type.Union(values.map(value => Type.Literal(value)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const text = Type.String();
const nonempty = Type.String({ minLength: 1 });
const count = Type.Integer({ minimum: 0 });
const instant = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$' });
export const RevisionSchema = Type.String({ pattern: '^[a-fA-F0-9]{64}$' });
// Filesystem containment and reparse-point checks are additionally required at use sites.
export const VaultPathSchema = Type.String({ minLength: 1, pattern: '^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*[\\\\:\\x00-\\x1f])(?!.*//)(?!.*\\/$).+$' });
export const ScopedMarkdownPathSchema = Type.Intersect([VaultPathSchema, Type.String({ pattern: '^(20_Sources|40_Knowledge)/.+\\.[mM][dD]$' })]);
export const CapturePathSchema = Type.Intersect([VaultPathSchema, Type.String({ pattern: '^20_Sources/.+\\.[mM][dD]$' })]);
export const ConfigSchema = object({
  config_version: Type.Literal(1), vault_path: nonempty, data_dir: nonempty,
  host: Type.Literal('127.0.0.1'), port: Type.Integer({ minimum: 1, maximum: 65535 }),
});
export type Config = Static<typeof ConfigSchema>;
export const isConfig = (value: unknown): value is Config => Value.Check(ConfigSchema, value);
export const ErrorCodeSchema = enumeration([
  'VALIDATION_ERROR', 'EMPTY_QUERY', 'UNAUTHORIZED', 'HOST_NOT_ALLOWED', 'ORIGIN_NOT_ALLOWED',
  'PATH_OUTSIDE_SCOPE', 'DOCUMENT_NOT_FOUND', 'JOB_NOT_FOUND', 'ROUTE_NOT_FOUND', 'JOB_BUSY',
  'PATH_CONFLICT', 'INVALID_SOURCE', 'PAYLOAD_TOO_LARGE', 'CORE_UNAVAILABLE', 'IO_ERROR',
  'CONFIG_ERROR', 'PORT_CONFLICT', 'INSTANCE_BUSY', 'INSTANCE_UNCERTAIN', 'DATABASE_ERROR',
  'SCHEMA_UNSUPPORTED', 'VAULT_MISMATCH',
] as const);
export type ErrorCode = Static<typeof ErrorCodeSchema>;
export const ErrorSchema = object({ error: object({ code: ErrorCodeSchema, message: nonempty, details: nullable(Type.Record(text, Type.Unknown())) }) });
export type ApiError = Static<typeof ErrorSchema>;
export const DiagnosticSchema = object({ code: nonempty, message: nonempty, path: nullable(VaultPathSchema) });
export const DiagnosticsSchema = Type.Array(DiagnosticSchema);
export const HealthSchema = object({ status: enumeration(['starting', 'ready', 'degraded']), core_version: nonempty, api_version: Type.Literal(API_VERSION) });
export type Health = Static<typeof HealthSchema>;
/** Registration state, independent of content stage and lifecycle. */
export const DocumentStateSchema = enumeration(['ready', 'invalid', 'missing', 'unsupported']);
export const PROCESSING_STATUSES = ['pending', 'compiled', 'reviewed', 'planned', 'archived'] as const;
/** Null means no readable stage, including a current file not yet normalized by Registry. */
export const ProcessingStatusSchema = nullable(enumeration(PROCESSING_STATUSES));
export const LIFECYCLE_STATUSES = ['active', 'discarded'] as const;
export const LifecycleStatusSchema = nullable(enumeration(LIFECYCLE_STATUSES));
export const DocumentKindSchema = enumeration(['source', 'knowledge']);
export const ScanModeSchema = enumeration(['refresh', 'rebuild']);
export const JobStatusSchema = enumeration(['queued', 'running', 'succeeded', 'failed', 'interrupted']);
export const ScanSummarySchema = object({
  added: count, updated: count, unchanged: count, missing: count, invalid: count, unsupported: count,
  source_count: count, knowledge_count: count, index_generation: count,
  warnings: DiagnosticsSchema, finished_at: instant,
});
export const JobSchema = object({
  id: nonempty, kind: Type.Literal('scan_vault'), mode: ScanModeSchema, status: JobStatusSchema,
  created_at: instant, started_at: nullable(instant), finished_at: nullable(instant),
  processed_files: count, summary: nullable(ScanSummarySchema), error: nullable(ErrorSchema.properties.error),
});
export type Job = Static<typeof JobSchema>;
export const AssetSchema = object({
  kind: enumeration(['inline_markdown', 'vault_file', 'external_ref']), locator: nonempty,
  availability: enumeration(['available', 'missing', 'unverified', 'unsupported']),
});
export type Asset = Static<typeof AssetSchema>;
export const ReferenceSchema = object({
  raw: text, target_path: nullable(VaultPathSchema), anchor: nullable(text), alias: nullable(text),
  availability: enumeration(['available', 'missing', 'ambiguous', 'outside_scope', 'unsupported', 'unverified']),
});
export const MetadataSchema = Type.Record(text, Type.Unknown());
export const SourceSchema = object({
  id: nonempty, path: VaultPathSchema, title: text, source_type: nullable(text), state: DocumentStateSchema,
  processing_status: ProcessingStatusSchema, lifecycle_status: LifecycleStatusSchema,
  revision: nullable(RevisionSchema), original_locator: nullable(text), captured_at: nullable(text),
  asset: nullable(AssetSchema), diagnostics: DiagnosticsSchema,
});
export type Source = Static<typeof SourceSchema>;
const documentCommon = {
  path: ScopedMarkdownPathSchema, revision: RevisionSchema, indexed_revision: nullable(RevisionSchema),
  index_stale: Type.Boolean(), indexed_at: nullable(instant), index_generation: count,
  title: text, metadata: MetadataSchema, annotation: text, diagnostics: DiagnosticsSchema,
  lifecycle_status: LifecycleStatusSchema,
  original_references: Type.Array(ReferenceSchema),
};
const sourceCommon = { ...documentCommon, kind: Type.Literal('source'), record_path: VaultPathSchema,
  source_type: nonempty, original_locator: nullable(text), captured_at: nullable(text),
  processing_status: ProcessingStatusSchema, body: Type.Null() };
export const DocumentSchema = Type.Union([
  object({ ...sourceCommon,
    asset: object({ ...AssetSchema.properties, kind: Type.Literal('inline_markdown') }),
    source_content: text, record_body: Type.Null(),
  }),
  object({ ...sourceCommon,
    asset: object({ ...AssetSchema.properties, kind: enumeration(['vault_file', 'external_ref']) }),
    source_content: Type.Null(), record_body: text,
  }),
  object({ ...documentCommon, kind: Type.Literal('knowledge'), record_path: Type.Null(),
    source_type: Type.Null(), original_locator: Type.Null(), captured_at: Type.Null(),
    asset: Type.Null(), source_content: Type.Null(), record_body: Type.Null(), body: text,
  }),
]);
export type Document = Static<typeof DocumentSchema>;
export const SearchFieldSchema = enumeration(['title', 'body', 'annotation', 'metadata']);
export const SearchResultSchema = object({
  id: nonempty, path: VaultPathSchema, kind: DocumentKindSchema, title: text, source_type: nullable(text),
  revision: RevisionSchema, matched_fields: Type.Array(SearchFieldSchema, { minItems: 1 }),
  snippet: Type.String({ maxLength: LIMITS.snippet_characters }), snippet_field: SearchFieldSchema,
  snippet_context: enumeration(['source_content', 'record_body', 'knowledge', 'user_context', 'metadata', 'title']),
});
export type SearchResult = Static<typeof SearchResultSchema>;
export const PaginationQuerySchema = object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.max_limit, default: LIMITS.default_limit })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
const page = <T extends TSchema>(item: T) => ({ items: Type.Array(item), total: count, limit: Type.Integer({ minimum: 1, maximum: LIMITS.max_limit }), offset: count });
const indexed = { index_generation: count, indexed_at: nullable(instant) };
export const JobsResponseSchema = object(page(JobSchema));
export type PaginationQuery = Static<typeof PaginationQuerySchema>;
export const SourcesQuerySchema = object({ ...PaginationQuerySchema.properties,
  state: Type.Optional(DocumentStateSchema), source_type: Type.Optional(nonempty), path_prefix: Type.Optional(VaultPathSchema),
});
export const SourcesResponseSchema = object({ ...page(SourceSchema), ...indexed });
export type SourcesQuery = Static<typeof SourcesQuerySchema>;
export const SearchQuerySchema = object({ ...PaginationQuerySchema.properties,
  scope: Type.Optional(enumeration(['knowledge', 'sources', 'all'])),
  q: Type.Optional(Type.String({ maxLength: LIMITS.query_characters })),
  fields: Type.Optional(Type.String({ pattern: '^(title|body|annotation|metadata)(,(title|body|annotation|metadata))*$' })),
  source_type: Type.Optional(nonempty), tag: Type.Optional(nonempty), path_prefix: Type.Optional(VaultPathSchema),
});
export type SearchQuery = Static<typeof SearchQuerySchema>;
export const SearchResponseSchema = object({ ...page(SearchResultSchema), ...indexed });
export const ScanRequestSchema = object({ mode: ScanModeSchema });
export type ScanRequest = Static<typeof ScanRequestSchema>;
export const ScanResponseSchema = object({ job: JobSchema, reused: Type.Boolean() });
export const CaptureRequestSchema = object({ path: CapturePathSchema, markdown: Type.String({ minLength: 1 }) });
export const CaptureResponseSchema = object({ path: CapturePathSchema, revision: RevisionSchema, created: Type.Boolean(), scan_required: Type.Literal(true) });
export type CaptureRequest = Static<typeof CaptureRequestSchema>;
export type CaptureResponse = Static<typeof CaptureResponseSchema>;
export const StatusSchema = object({
  ...HealthSchema.properties, instance_id: nonempty, vault_path: nonempty, data_dir: nonempty,
  database_initialized: Type.Boolean(), active_job: nullable(JobSchema),
  index_generation: count, last_scan_at: nullable(instant),
  counts: object({ sources: count, knowledge: count, invalid: count, missing: count, unsupported: count }),
  scan_roots: Type.Array(object({ path: enumeration(SCAN_ROOTS), available: Type.Boolean() })),
  limits: object(Object.fromEntries(Object.entries(LIMITS).map(([key, value]) => [key, Type.Literal(value)]))),
  diagnostics: DiagnosticsSchema,
});
export type Status = Static<typeof StatusSchema>;
const empty = object({});
const errors = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 413: ErrorSchema, 422: ErrorSchema, 500: ErrorSchema, 503: ErrorSchema };
/** Implemented endpoints. Schema declarations do not register unimplemented handlers. */
export const API = {
  health: { method: 'GET', url: '/v1/health', schema: { querystring: empty, response: { ...errors, 200: HealthSchema, 503: HealthSchema } } },
  status: { method: 'GET', url: '/v1/status', schema: { querystring: empty, response: { ...errors, 200: StatusSchema } } },
  scans: { method: 'POST', url: '/v1/scans', schema: { body: ScanRequestSchema, querystring: empty, response: { ...errors, 202: ScanResponseSchema } } },
  jobs: { method: 'GET', url: '/v1/jobs', schema: { querystring: PaginationQuerySchema, response: { ...errors, 200: JobsResponseSchema } } },
  job: { method: 'GET', url: '/v1/jobs/:id', schema: { params: object({ id: nonempty }), querystring: empty, response: { ...errors, 200: JobSchema } } },
  sources: { method: 'GET', url: '/v1/sources', schema: { querystring: SourcesQuerySchema, response: { ...errors, 200: SourcesResponseSchema } } },
  documents: { method: 'GET', url: '/v1/documents', schema: { querystring: object({ path: ScopedMarkdownPathSchema }), response: { ...errors, 200: DocumentSchema } } },
  search: { method: 'GET', url: '/v1/search', schema: { querystring: SearchQuerySchema, response: { ...errors, 200: SearchResponseSchema } } },
  captures: { method: 'POST', url: '/v1/captures', schema: { querystring: empty, body: CaptureRequestSchema, response: { ...errors, 200: CaptureResponseSchema, 201: CaptureResponseSchema } } },
} as const;
