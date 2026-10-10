import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const API_VERSION = '1';
export const CORE_VERSION = '0.1.0';
export const SCHEMA_VERSION = 5;
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
export const SCAN_ROOTS = ['10_Ideas', '20_Sources', '40_Knowledge', '50_Research'] as const;
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
export const ScopedMarkdownPathSchema = Type.Intersect([VaultPathSchema, Type.String({ pattern: '^(10_Ideas|20_Sources|40_Knowledge|50_Research)/.+\\.[mM][dD]$' })]);
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
  'EXECUTION_FAILED', 'INVALID_MODEL_OUTPUT', 'UNSUPPORTED_CONTENT', 'SOURCE_CHANGED', 'COMPILATION_RECOVERY_CONFLICT',
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
export const DocumentKindSchema = enumeration(['source', 'knowledge', 'idea', 'research']);
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
export const CompilerResultSchema = object({ title: Type.String({ minLength: 1, maxLength: 500 }), body: Type.String({ minLength: 1, maxLength: 1_000_000 }) });
export type CompilerResult = Static<typeof CompilerResultSchema>;
export const CompilerSettingsSchema = object({
  route: enumeration(['api', 'codex']), model: Type.String({ maxLength: 200 }),
  endpoint: Type.String({ maxLength: 2000 }), codex_path: Type.String({ maxLength: 4096 }),
  output_format: enumeration(['json_schema', 'json_object', 'text']),
  reasoning_effort: enumeration(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']),
  timeout_seconds: Type.Integer({ minimum: 10, maximum: 1800 }),
  output_tokens: Type.Optional(object({ parameter: enumeration(['max_tokens', 'max_completion_tokens']), limit: Type.Integer({ minimum: 1, maximum: 131072 }) })),
});
export type CompilerSettings = Static<typeof CompilerSettingsSchema>;
export const CompilerSettingsResponseSchema = object({ settings: CompilerSettingsSchema, api_key_configured: Type.Boolean() });
export const CompilerSettingsWriteSchema = object({ settings: CompilerSettingsSchema, api_key: Type.Optional(Type.String({ maxLength: 8192 })) });
export const DraftPathSchema = Type.Intersect([VaultPathSchema, Type.String({ pattern: '^30_Drafts/.+\\.[mM][dD]$' })]);
export const DraftSchema = object({ path: DraftPathSchema, title: text, body: text, revision: RevisionSchema,
  sources: Type.Array(CapturePathSchema, { minItems: 1 }), lifecycle_status: enumeration(LIFECYCLE_STATUSES), metadata: Type.Record(text, Type.Unknown()) });
export type Draft = Static<typeof DraftSchema>;
export const CompileRequestSchema = object({ path: CapturePathSchema, revision: RevisionSchema,
  request_id: Type.String({ pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' }) });
export type CompileRequest = Static<typeof CompileRequestSchema>;
export const ExecutionAttemptSchema = object({ number: count, status: enumeration(['running','succeeded','failed','interrupted']),
  started_at: instant, finished_at: nullable(instant), error: nullable(ErrorSchema.properties.error), next_retry_at: nullable(instant) });
export type ExecutionAttempt = Static<typeof ExecutionAttemptSchema>;
export const CompilerJobSchema = object({ id: nonempty, kind: Type.Literal('compile_source'), status: JobStatusSchema,
  attempts: Type.Optional(Type.Array(ExecutionAttemptSchema)),
  created_at: instant, started_at: nullable(instant), finished_at: nullable(instant),
  source_path: CapturePathSchema, source_revision: RevisionSchema, draft_path: nullable(DraftPathSchema),
  route: enumeration(['api', 'codex']), model: text, prompt_version: Type.Literal('compiler-v1'),
  error: nullable(ErrorSchema.properties.error) });
export type CompilerJob = Static<typeof CompilerJobSchema>;
export const AnalysisProfileIdSchema = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' });
export const AnalysisTemplatePathSchema = Type.Intersect([VaultPathSchema, Type.String({ pattern: '^90_System/Prompts/(Review|Relation)/[a-zA-Z0-9_-]+\\.md$' })]);
export const AnalysisTaskSchema = object({ template_path: AnalysisTemplatePathSchema, execution: CompilerSettingsSchema });
export const AnalysisProfileSchema = object({ id: AnalysisProfileIdSchema, name: Type.String({ minLength: 1, maxLength: 100 }),
  review: AnalysisTaskSchema, relation: AnalysisTaskSchema, reuse: enumeration(['input', 'output', 'none']) });
export type AnalysisProfile = Static<typeof AnalysisProfileSchema>;
export const AnalysisSettingsSchema = object({ default_profile: nullable(AnalysisProfileIdSchema), profiles: Type.Array(AnalysisProfileSchema, { maxItems: 20 }) });
export type AnalysisSettings = Static<typeof AnalysisSettingsSchema>;
export const AnalysisSettingsResponseSchema = object({ settings: AnalysisSettingsSchema, credentials: Type.Array(object({ profile_id: AnalysisProfileIdSchema, review: Type.Boolean(), relation: Type.Boolean() })) });
export const AnalysisSettingsWriteSchema = object({ settings: AnalysisSettingsSchema, credentials: Type.Optional(Type.Array(object({ profile_id: AnalysisProfileIdSchema, task: enumeration(['review','relation']), api_key: Type.String({ minLength: 1, maxLength: 8192 }) }), { maxItems: 40 })) });
export const AnalysisTemplateSchema = object({ path: AnalysisTemplatePathSchema, content: Type.String({ maxLength: 64000 }), revision: RevisionSchema });
export const AnalyzeRequestSchema = object({ request_id: CompileRequestSchema.properties.request_id, source_path: CapturePathSchema, source_revision: RevisionSchema,
  draft_path: DraftPathSchema, draft_revision: RevisionSchema, profile_id: Type.Optional(AnalysisProfileIdSchema), task: Type.Optional(enumeration(['review','relation'])) });
export type AnalyzeRequest = Static<typeof AnalyzeRequestSchema>;
export const AnalysisCitationSchema = object({ path: Type.Union([ScopedMarkdownPathSchema, DraftPathSchema]), revision: RevisionSchema,
  start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }) });
export const ReviewResultSchema = object({ summary: Type.String({ maxLength: 12000 }), findings: Type.Array(object({
  category: Type.Optional(enumeration(['omission','meaning','understanding','error','claim','scope','other'])), message: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(AnalysisCitationSchema, { minItems: 1, maxItems: 10 }) }), { maxItems: 30 }), limitations: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 20 }) });
export const RelationResultSchema = object({ summary: Type.String({ maxLength: 12000 }), suggestions: Type.Array(object({
  category: Type.Optional(enumeration(['connection','conflict','integration','merge','new_viewpoint'])), message: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(AnalysisCitationSchema, { minItems: 1, maxItems: 10 }) }), { maxItems: 30 }), limitations: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 20 }) });
export type ReviewResult = Static<typeof ReviewResultSchema>;
export type RelationResult = Static<typeof RelationResultSchema>;
export const AnalyzerTaskStateSchema = object({ status: enumeration(['pending','running','succeeded','failed','interrupted','skipped']), route: enumeration(['api','codex']), model: text,
  attempts: Type.Optional(Type.Array(ExecutionAttemptSchema)),
  started_at: nullable(instant), finished_at: nullable(instant), error: nullable(ErrorSchema.properties.error) });
export const AnalyzerJobSchema = object({ id: nonempty, kind: Type.Literal('analyze_draft'), status: JobStatusSchema, created_at: instant, started_at: nullable(instant), finished_at: nullable(instant),
  review_reference_id: Type.Optional(nonempty),
  source_path: CapturePathSchema, source_revision: RevisionSchema, draft_path: DraftPathSchema, draft_revision: RevisionSchema, profile_id: AnalysisProfileIdSchema,
  review: AnalyzerTaskStateSchema, relation: AnalyzerTaskStateSchema, error: nullable(ErrorSchema.properties.error) });
export type AnalyzerJob = Static<typeof AnalyzerJobSchema>;
export const AnyJobSchema = Type.Union([JobSchema, CompilerJobSchema, AnalyzerJobSchema]);
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
  asset: nullable(AssetSchema), diagnostics: DiagnosticsSchema, recompile_count: Type.Optional(count),
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
const libraryCommon = { ...documentCommon, record_path: Type.Null(), source_type: Type.Null(), original_locator: Type.Null(), captured_at: Type.Null(),
  asset: Type.Null(), source_content: Type.Null(), record_body: Type.Null(), body: text };
export const DocumentSchema = Type.Union([
  object({ ...sourceCommon,
    asset: object({ ...AssetSchema.properties, kind: Type.Literal('inline_markdown') }),
    source_content: text, record_body: Type.Null(),
  }),
  object({ ...sourceCommon,
    asset: object({ ...AssetSchema.properties, kind: enumeration(['vault_file', 'external_ref']) }),
    source_content: Type.Null(), record_body: text,
  }),
  object({ ...libraryCommon, kind: Type.Literal('knowledge') }),
  object({ ...libraryCommon, kind: Type.Literal('idea') }),
  object({ ...libraryCommon, kind: Type.Literal('research') }),
]);
export type Document = Static<typeof DocumentSchema>;
export const SearchFieldSchema = enumeration(['title', 'body', 'annotation', 'metadata']);
export const SearchResultSchema = object({
  id: nonempty, path: VaultPathSchema, kind: DocumentKindSchema, title: text, source_type: nullable(text),
  revision: RevisionSchema, matched_fields: Type.Array(SearchFieldSchema, { minItems: 1 }),
  snippet: Type.String({ maxLength: LIMITS.snippet_characters }), snippet_field: SearchFieldSchema,
  snippet_context: enumeration(['source_content', 'record_body', 'knowledge', 'idea', 'research', 'user_context', 'metadata', 'title']),
});
export type SearchResult = Static<typeof SearchResultSchema>;
export const PaginationQuerySchema = object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.max_limit, default: LIMITS.default_limit })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
const page = <T extends TSchema>(item: T) => ({ items: Type.Array(item), total: count, limit: Type.Integer({ minimum: 1, maximum: LIMITS.max_limit }), offset: count });
const indexed = { index_generation: count, indexed_at: nullable(instant) };
export const JobsResponseSchema = object(page(AnyJobSchema));
export type PaginationQuery = Static<typeof PaginationQuerySchema>;
export const SOURCE_VIEWS = ['all', 'pending', 'processing', 'archived', 'issues', 'discarded'] as const;
export const SourceViewSchema = enumeration(SOURCE_VIEWS);
export const SourcesQuerySchema = object({ ...PaginationQuerySchema.properties,
  state: Type.Optional(DocumentStateSchema), source_type: Type.Optional(nonempty), path_prefix: Type.Optional(VaultPathSchema),
  view: Type.Optional(SourceViewSchema), q: Type.Optional(Type.String({ maxLength: 200 })),
  types: Type.Optional(Type.String({ maxLength: 4096 })), tags: Type.Optional(Type.String({ maxLength: 4096 })),
  stages: Type.Optional(Type.String({ maxLength: 4096 })), issues: Type.Optional(Type.String({ maxLength: 4096 })),
  captured_from: Type.Optional(instant), captured_to: Type.Optional(instant),
  time_ranges: Type.Optional(Type.String({ maxLength: 4096 })),
  recompile: Type.Optional(enumeration(['first','recompile'])),
  sort: Type.Optional(enumeration(['title_asc', 'title_desc', 'captured_asc', 'captured_desc'])),
});
export const SourcesResponseSchema = object({ ...page(SourceSchema), ...indexed,
  views: Type.Optional(object(Object.fromEntries(SOURCE_VIEWS.map(view => [view, count])))),
  facets: Type.Optional(object({ types: Type.Array(text), tags: Type.Array(text) })),
});
export type SourcesQuery = Static<typeof SourcesQuerySchema>;
const LifecycleTargetSchema = object({ path: ScopedMarkdownPathSchema, revision: RevisionSchema });
const RelatedTargetSchema = object({ path: Type.Union([ScopedMarkdownPathSchema, DraftPathSchema]), revision: RevisionSchema });
export const SourceBatchRequestSchema = object({ id: CompileRequestSchema.properties.request_id, action: enumeration(['compile', 'discard', 'restore', 'discard_drafts', 'delete']),
  items: Type.Array(object({ ...LifecycleTargetSchema.properties, request_id: CompileRequestSchema.properties.request_id, related: Type.Optional(Type.Array(RelatedTargetSchema, { maxItems: 100 })), allow_referenced: Type.Optional(Type.Boolean()), reference_revisions: Type.Optional(Type.Array(LifecycleTargetSchema, { maxItems: 100 })) }), { minItems: 1, maxItems: 100 }),
});
export type SourceBatchRequest = Static<typeof SourceBatchRequestSchema>;
export const SourceBatchSchema = object({ id: nonempty, action: enumeration(['compile', 'discard', 'restore', 'discard_drafts', 'delete']), status: enumeration(['running', 'completed', 'interrupted']),
  items: Type.Array(object({ path: VaultPathSchema, status: enumeration(['pending', 'running', 'succeeded', 'failed', 'skipped']), job_id: nullable(text), error: nullable(object({ code: text, message: text })) })),
});
export type SourceBatch = Static<typeof SourceBatchSchema>;
export const DiscardPreviewSchema = object({ source: LifecycleTargetSchema, drafts: Type.Array(object({ ...RelatedTargetSchema.properties, title: Type.Optional(text) })), references: Type.Array(LifecycleTargetSchema) });
export const SearchQuerySchema = object({ ...PaginationQuerySchema.properties,
  scope: Type.Optional(enumeration(['knowledge', 'ideas', 'research', 'sources', 'all'])),
  q: Type.Optional(Type.String({ maxLength: LIMITS.query_characters })),
  fields: Type.Optional(Type.String({ pattern: '^(title|body|annotation|metadata)(,(title|body|annotation|metadata))*$' })),
  source_type: Type.Optional(nonempty), tag: Type.Optional(nonempty), path_prefix: Type.Optional(VaultPathSchema),
});
export type SearchQuery = Static<typeof SearchQuerySchema>;
export const SearchResponseSchema = object({ ...page(SearchResultSchema), ...indexed });
export const ScanRequestSchema = object({ mode: ScanModeSchema });
export type ScanRequest = Static<typeof ScanRequestSchema>;
export const ScanResponseSchema = object({ job: JobSchema, reused: Type.Boolean() });
export const CaptureRequestSchema = object({ path: CapturePathSchema, markdown: Type.String({ minLength: 1 }), analysis_profile: Type.Optional(AnalysisProfileIdSchema) });
export const PaperLocatorSchema = Type.String({ pattern: '^zotero://select/(?:library|groups/[1-9][0-9]*)/items/[A-Z0-9]{8}$' });
export const CaptureResponseSchema = object({ path: CapturePathSchema, revision: RevisionSchema, created: Type.Boolean(), scan_required: Type.Literal(true) });
export type CaptureRequest = Static<typeof CaptureRequestSchema>;
export type CaptureResponse = Static<typeof CaptureResponseSchema>;
export const ProcessingSettingsSchema = object({ enabled: Type.Boolean(), mode: enumeration(['daily','interval']),
  daily_time: Type.String({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }), time_zone: Type.String({ minLength: 1, maxLength: 100 }),
  interval_minutes: Type.Integer({ minimum: 1, maximum: 10080 }), max_retries: Type.Integer({ minimum: 0, maximum: 5 }) });
export type ProcessingSettings = Static<typeof ProcessingSettingsSchema>;
export const ProcessingRequestSchema = object({ request_id: CompileRequestSchema.properties.request_id, mode: enumeration(['pending','selected','analyze']),
  items: Type.Optional(Type.Array(object({ source_path: CapturePathSchema, source_revision: Type.Optional(RevisionSchema),
    draft_path: Type.Optional(DraftPathSchema), draft_revision: Type.Optional(RevisionSchema), profile_id: Type.Optional(AnalysisProfileIdSchema),
    task: Type.Optional(enumeration(['review','relation'])) }), { minItems: 1, maxItems: 100 })) });
export type ProcessingRequest = Static<typeof ProcessingRequestSchema>;
export const ProcessingRoundSchema = object({ id: nonempty, mode: enumeration(['pending','selected','analyze']), trigger: enumeration(['manual','schedule']),
  status: JobStatusSchema, created_at: instant, started_at: nullable(instant), finished_at: nullable(instant), max_retries: count,
  registration_job_id: nullable(text), error: nullable(ErrorSchema.properties.error), items: Type.Array(object({
    source_path: CapturePathSchema, source_revision: nullable(RevisionSchema), draft_path: nullable(DraftPathSchema), draft_revision: nullable(RevisionSchema),
    status: enumeration(['pending','running','succeeded','failed','skipped','interrupted']),
    phase: enumeration(['waiting','compiler','analyzer','finished']), task: Type.Optional(enumeration(['review','relation'])),
    compiler_job_id: nullable(text), analyzer_job_id: nullable(text), error: nullable(ErrorSchema.properties.error),
  }), { maxItems: 10000 }) });
export type ProcessingRound = Static<typeof ProcessingRoundSchema>;
export const ScheduleStateSchema = object({ next_due: nullable(instant), waiting: Type.Boolean(), last_trigger: nullable(instant), reason: nullable(text) });
export type ScheduleState = Static<typeof ScheduleStateSchema>;
export const RecompileRequestSchema = object({ request_id: CompileRequestSchema.properties.request_id, source_path: CapturePathSchema, source_revision: RevisionSchema,
  draft_path: DraftPathSchema, draft_revision: RevisionSchema, feedback: Type.String({ maxLength: 8000 }) });
export type RecompileRequest = Static<typeof RecompileRequestSchema>;
export const RecompileResponseSchema = object({ path: CapturePathSchema, revision: RevisionSchema, recompile_count: count, reused: Type.Boolean() });
export type RecompileResponse = Static<typeof RecompileResponseSchema>;
export const StatusSchema = object({
  ...HealthSchema.properties, instance_id: nonempty, vault_path: nonempty, data_dir: nonempty,
  database_initialized: Type.Boolean(), active_job: nullable(AnyJobSchema),
  index_generation: count, last_scan_at: nullable(instant),
  counts: object({ sources: count, knowledge: count, ideas: Type.Optional(count), research: Type.Optional(count), invalid: count, missing: count, unsupported: count, pending: Type.Optional(count) }),
  scan_roots: Type.Array(object({ path: enumeration(SCAN_ROOTS), available: Type.Boolean() })),
  limits: object(Object.fromEntries(Object.entries(LIMITS).map(([key, value]) => [key, Type.Literal(value)]))),
  diagnostics: DiagnosticsSchema,
  source_batch: Type.Optional(nullable(SourceBatchSchema)),
  processing_round: Type.Optional(nullable(ProcessingRoundSchema)),
  processing_schedule: Type.Optional(ScheduleStateSchema),
  semantic_index: Type.Optional(object({ state: enumeration(['not_built', 'idle', 'running', 'failed', 'interrupted', 'rebuild_required']), stale_documents: count, error: nullable(text) })),
});
export type Status = Static<typeof StatusSchema>;
const empty = object({});
const errors = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 413: ErrorSchema, 422: ErrorSchema, 500: ErrorSchema, 503: ErrorSchema };
export const RecallSettingsSchema = object({
  endpoint: Type.String({ maxLength: 2000 }), model: Type.String({ maxLength: 512 }),
  query_instruction: Type.String({ maxLength: 2000 }), timeout_seconds: Type.Integer({ minimum: 5, maximum: 300 }),
  reranker_enabled: Type.Boolean(), reranker_endpoint: Type.String({ maxLength: 2000 }), reranker_model: Type.String({ maxLength: 512 }),
  candidates: Type.Integer({ minimum: 20, maximum: 50 }),
});
export type RecallSettings = Static<typeof RecallSettingsSchema>;
export const RecallSettingsResponseSchema = object({ settings: RecallSettingsSchema, api_key_configured: Type.Boolean(), reranker_key_configured: Type.Boolean() });
export const RecallSettingsWriteSchema = object({ settings: RecallSettingsSchema, api_key: Type.Optional(Type.String({ maxLength: 8192 })), reranker_key: Type.Optional(Type.String({ maxLength: 8192 })) });
export const RecallStatusSchema = object({
  state: enumeration(['not_built', 'idle', 'running', 'failed', 'interrupted', 'rebuild_required']),
  initialized: Type.Boolean(), indexed_documents: count, indexed_chunks: count, eligible_documents: count, stale_documents: count,
  fingerprint: nullable(text), indexed_at: nullable(instant), generation: count,
  processed_documents: count, embedded_chunks: count, reused_chunks: count,
  error: nullable(text), diagnostics: DiagnosticsSchema,
});
export type RecallStatus = Static<typeof RecallStatusSchema>;
export const RecallQuerySchema = object({
  q: Type.String({ minLength: 1, maxLength: 2000 }),
  scope: Type.Optional(enumeration(['all', 'knowledge', 'ideas', 'research'])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), rerank: Type.Optional(Type.Boolean()),
});
export type RecallQuery = Static<typeof RecallQuerySchema>;
export const RecallHitSchema = object({
  chunk_id: nonempty, path: ScopedMarkdownPathSchema, kind: enumeration(['knowledge', 'idea', 'research']),
  title: text, heading: text, revision: RevisionSchema, text: text,
  start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }),
  score: Type.Number(), channels: Type.Array(enumeration(['bm25', 'embedding'])),
  rerank_score: nullable(Type.Number()),
});
export type RecallHit = Static<typeof RecallHitSchema>;
export const RecallResponseSchema = object({
  items: Type.Array(RecallHitSchema), coverage: RecallStatusSchema,
  reranker: enumeration(['disabled', 'applied', 'failed']), diagnostics: DiagnosticsSchema,
  timings: object({ embedding_ms: Type.Number(), retrieval_ms: Type.Number(), rerank_ms: Type.Number(), total_ms: Type.Number() }),
});
export type RecallResponse = Static<typeof RecallResponseSchema>;
export const RecallContextRequestSchema = object({ items: Type.Array(object({ chunk_id: nonempty, path: ScopedMarkdownPathSchema, revision: RevisionSchema }), { minItems: 1, maxItems: 60 }) });
export const RecallContextResponseSchema = object({ items: Type.Array(RecallHitSchema), diagnostics: DiagnosticsSchema, truncated: Type.Boolean() });
export const KnowledgePathSchema = Type.Intersect([VaultPathSchema, Type.String({ pattern: '^40_Knowledge/.+\\.[mM][dD]$' })]);
const ReviewTargetSchema = object({ path: DraftPathSchema, revision: RevisionSchema, title: text });
export const PublishDraftRequestSchema = object({
  request_id: Type.String({ pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' }),
  draft_path: DraftPathSchema, draft_revision: RevisionSchema,
  source_path: CapturePathSchema, source_revision: RevisionSchema,
  target_path: KnowledgePathSchema, analysis_id: nonempty,
  related_drafts: Type.Array(object({ path: DraftPathSchema, revision: RevisionSchema }), { minItems: 1, maxItems: 100 }),
});
export type PublishDraftRequest = Static<typeof PublishDraftRequestSchema>;
export const DraftReviewSchema = object({
  draft: DraftSchema, source: DocumentSchema, related_drafts: Type.Array(ReviewTargetSchema),
  diagnostics: DiagnosticsSchema, analysis: nullable(AnalyzerJobSchema),
  analyses: Type.Optional(object({ review: nullable(AnalyzerJobSchema), relation: nullable(AnalyzerJobSchema) })),
  publication: nullable(object({ request: PublishDraftRequestSchema, status: enumeration(['completed', 'unfinished']), error: nullable(text) })),
});
export type DraftReview = Static<typeof DraftReviewSchema>;
export const PublishDraftResponseSchema = object({
  request_id: nonempty, target_path: KnowledgePathSchema, source_path: CapturePathSchema,
  discarded_drafts: Type.Array(DraftPathSchema), status: Type.Literal('completed'), reused: Type.Boolean(),
});
export type PublishDraftResponse = Static<typeof PublishDraftResponseSchema>;
/** Implemented endpoints. Schema declarations do not register unimplemented handlers. */
export const API = {
  processingSettings: { method: 'GET', url: '/v1/processing/settings', schema: { querystring: empty, response: { ...errors, 200: ProcessingSettingsSchema } } },
  processingSettingsWrite: { method: 'POST', url: '/v1/processing/settings', schema: { querystring: empty, body: ProcessingSettingsSchema, response: { ...errors, 200: ProcessingSettingsSchema } } },
  processingState: { method: 'GET', url: '/v1/processing/state', schema: { querystring: empty, response: { ...errors, 200: object({ schedule: ScheduleStateSchema, active: nullable(ProcessingRoundSchema), latest: nullable(ProcessingRoundSchema) }) } } },
  processing: { method: 'POST', url: '/v1/processing-rounds', schema: { querystring: empty, body: ProcessingRequestSchema, response: { ...errors, 202: object({ round: ProcessingRoundSchema, reused: Type.Boolean() }) } } },
  processingRounds: { method: 'GET', url: '/v1/processing-rounds', schema: { querystring: PaginationQuerySchema, response: { ...errors, 200: object(page(ProcessingRoundSchema)) } } },
  processingRound: { method: 'GET', url: '/v1/processing-round', schema: { querystring: object({ id: nonempty }), response: { ...errors, 200: ProcessingRoundSchema } } },
  processingCancel: { method: 'POST', url: '/v1/processing/cancel', schema: { querystring: empty, body: object({ id: nonempty }), response: { ...errors, 200: ProcessingRoundSchema } } },
  recompile: { method: 'POST', url: '/v1/recompile', schema: { querystring: empty, body: RecompileRequestSchema, response: { ...errors, 200: RecompileResponseSchema } } },
  draftReview: { method: 'GET', url: '/v1/draft-review', schema: { querystring: object({ path: DraftPathSchema }), response: { ...errors, 200: DraftReviewSchema } } },
  publishDraft: { method: 'POST', url: '/v1/draft-publications', schema: { querystring: empty, body: PublishDraftRequestSchema, response: { ...errors, 200: PublishDraftResponseSchema } } },
  analysisSettings: { method: 'GET', url: '/v1/analysis/settings', schema: { querystring: empty, response: { ...errors, 200: AnalysisSettingsResponseSchema } } },
  analysisSettingsWrite: { method: 'POST', url: '/v1/analysis/settings', schema: { querystring: empty, body: AnalysisSettingsWriteSchema, response: { ...errors, 200: AnalysisSettingsResponseSchema } } },
  analysisTemplates: { method: 'GET', url: '/v1/analysis/templates', schema: { querystring: empty, response: { ...errors, 200: object({ items: Type.Array(AnalysisTemplateSchema) }) } } },
  analysisTemplateWrite: { method: 'POST', url: '/v1/analysis/template', schema: { querystring: empty, body: AnalysisTemplateSchema, response: { ...errors, 200: AnalysisTemplateSchema } } },
  analysisSelection: { method: 'POST', url: '/v1/analysis/selection', schema: { querystring: empty, body: object({ path: CapturePathSchema, revision: RevisionSchema, profile_id: AnalysisProfileIdSchema }), response: { ...errors, 200: object({ path: CapturePathSchema, revision: RevisionSchema }) } } },
  analyze: { method: 'POST', url: '/v1/analyses', schema: { querystring: empty, body: AnalyzeRequestSchema, response: { ...errors, 202: object({ job: AnalyzerJobSchema, reused: Type.Boolean() }) } } },
  analysisCancel: { method: 'POST', url: '/v1/analysis/cancel', schema: { querystring: empty, body: object({ id: nonempty }), response: { ...errors, 200: AnalyzerJobSchema } } },
  analysisResult: { method: 'GET', url: '/v1/analysis/result', schema: { querystring: object({ id: nonempty }), response: { ...errors, 200: object({ job: AnalyzerJobSchema, stale: Type.Boolean(), stale_reasons: Type.Array(text), review: nullable(ReviewResultSchema), relation: nullable(RelationResultSchema), record: Type.Record(text, Type.Unknown()) }) } } },
  recallSettings: { method: 'GET', url: '/v1/recall/settings', schema: { querystring: empty, response: { ...errors, 200: RecallSettingsResponseSchema } } },
  recallSettingsWrite: { method: 'POST', url: '/v1/recall/settings', schema: { querystring: empty, body: RecallSettingsWriteSchema, response: { ...errors, 200: RecallSettingsResponseSchema } } },
  recallTest: { method: 'POST', url: '/v1/recall/test', schema: { querystring: empty, body: empty, response: { ...errors, 200: object({ dimensions: count, reranker: enumeration(['disabled','available']) }) } } },
  recallStatus: { method: 'GET', url: '/v1/recall/status', schema: { querystring: empty, response: { ...errors, 200: RecallStatusSchema } } },
  recallIndex: { method: 'POST', url: '/v1/recall/index', schema: { querystring: empty, body: object({ mode: enumeration(['build', 'update', 'rebuild']) }), response: { ...errors, 202: RecallStatusSchema } } },
  recall: { method: 'POST', url: '/v1/recall', schema: { querystring: empty, body: RecallQuerySchema, response: { ...errors, 200: RecallResponseSchema } } },
  recallContext: { method: 'POST', url: '/v1/recall/context', schema: { querystring: empty, body: RecallContextRequestSchema, response: { ...errors, 200: RecallContextResponseSchema } } },
  health: { method: 'GET', url: '/v1/health', schema: { querystring: empty, response: { ...errors, 200: HealthSchema, 503: HealthSchema } } },
  status: { method: 'GET', url: '/v1/status', schema: { querystring: empty, response: { ...errors, 200: StatusSchema } } },
  scans: { method: 'POST', url: '/v1/scans', schema: { body: ScanRequestSchema, querystring: empty, response: { ...errors, 202: ScanResponseSchema } } },
  jobs: { method: 'GET', url: '/v1/jobs', schema: { querystring: PaginationQuerySchema, response: { ...errors, 200: JobsResponseSchema } } },
  job: { method: 'GET', url: '/v1/jobs/:id', schema: { params: object({ id: nonempty }), querystring: empty, response: { ...errors, 200: AnyJobSchema } } },
  sources: { method: 'GET', url: '/v1/sources', schema: { querystring: SourcesQuerySchema, response: { ...errors, 200: SourcesResponseSchema } } },
  documents: { method: 'GET', url: '/v1/documents', schema: { querystring: object({ path: ScopedMarkdownPathSchema }), response: { ...errors, 200: DocumentSchema } } },
  search: { method: 'GET', url: '/v1/search', schema: { querystring: SearchQuerySchema, response: { ...errors, 200: SearchResponseSchema } } },
  captures: { method: 'POST', url: '/v1/captures', schema: { querystring: empty, body: CaptureRequestSchema, response: { ...errors, 200: CaptureResponseSchema, 201: CaptureResponseSchema } } },
  compilerSettings: { method: 'GET', url: '/v1/compiler/settings', schema: { querystring: empty, response: { ...errors, 200: CompilerSettingsResponseSchema } } },
  compilerSettingsWrite: { method: 'POST', url: '/v1/compiler/settings', schema: { querystring: empty, body: CompilerSettingsWriteSchema, response: { ...errors, 200: CompilerSettingsResponseSchema } } },
  compile: { method: 'POST', url: '/v1/compilations', schema: { querystring: empty, body: CompileRequestSchema, response: { ...errors, 202: object({ job: CompilerJobSchema, reused: Type.Boolean() }) } } },
  drafts: { method: 'GET', url: '/v1/drafts', schema: { querystring: object({ source_path: CapturePathSchema }), response: { ...errors, 200: object({ items: Type.Array(DraftSchema), diagnostics: DiagnosticsSchema }) } } },
  draft: { method: 'GET', url: '/v1/draft', schema: { querystring: object({ path: DraftPathSchema }), response: { ...errors, 200: DraftSchema } } },
  sourceBatch: { method: 'POST', url: '/v1/source-batches', schema: { querystring: empty, body: SourceBatchRequestSchema, response: { ...errors, 202: SourceBatchSchema } } },
  sourceBatchStatus: { method: 'GET', url: '/v1/source-batches', schema: { querystring: object({ id: nonempty }), response: { ...errors, 200: SourceBatchSchema } } },
  discardPreview: { method: 'GET', url: '/v1/source-discard-preview', schema: { querystring: object({ path: CapturePathSchema }), response: { ...errors, 200: DiscardPreviewSchema } } },
} as const;
