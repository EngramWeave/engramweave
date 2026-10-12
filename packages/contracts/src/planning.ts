import { Type, type Static, type TSchema } from '@sinclair/typebox';

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const enumeration = <T extends string>(items: readonly T[]) => Type.Union(items.map(item => Type.Literal(item)));
const text = Type.String();
const uuid = Type.String({ pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' });
const revision = Type.String({ pattern: '^[a-f0-9]{64}$' });
const instant = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$' });
const relative = Type.String({ minLength: 1, maxLength: 2048 });
const error = nullable(object({ code: text, message: text, details: nullable(Type.Record(text, Type.Unknown())) }));
export const PlannerSettingsSchema = object({ enabled: Type.Boolean(), model: Type.String({ maxLength: 200 }), codex_path: Type.String({ maxLength: 4096 }),
  reasoning_effort: enumeration(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']), timeout_seconds: Type.Integer({ minimum: 10, maximum: 1800 }),
  relation_template_path: nullable(Type.String({ pattern: '^90_System/Prompts/Relation/[a-zA-Z0-9_-]+\\.md$' })) });
export type PlannerSettings = Static<typeof PlannerSettingsSchema>;
export const PlanRequestSchema = object({ request_id: uuid, source_path: Type.String({ pattern: '^20_Sources/.+\\.[mM][dD]$' }), source_revision: Type.Optional(revision) });
export type PlanRequest = Static<typeof PlanRequestSchema>;
export const PlannerJobSchema = object({ id: uuid, kind: Type.Literal('plan_integration'), status: enumeration(['queued','running','succeeded','failed','interrupted']),
  created_at: instant, started_at: nullable(instant), finished_at: nullable(instant), source_path: relative, source_revision: revision, draft_path: relative,
  draft_revision: revision, model: text, changeset_id: nullable(uuid), error,
  attempts: Type.Array(object({ number: Type.Integer({ minimum: 1 }), status: enumeration(['running','succeeded','failed','interrupted']), started_at: instant,
    finished_at: nullable(instant), error, next_retry_at: nullable(instant) })) });
export type PlannerJob = Static<typeof PlannerJobSchema>;
export const ChangeSetEvidenceSchema = object({ path: relative, revision, start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }) });
export const ChangeSetItemSchema = object({ id: uuid, kind: enumeration(['write','directory','discard']), target: relative, candidate_path: nullable(relative), before_revision: nullable(revision),
  reason: Type.String({ minLength: 1, maxLength: 8000 }), evidence: Type.Array(ChangeSetEvidenceSchema, { maxItems: 40 }), requires_domain_approval: Type.Boolean() });
export type ChangeSetItem = Static<typeof ChangeSetItemSchema>;
export const ChangeSetSchema = object({ version: Type.Literal(1), id: uuid, created_at: instant, state: enumeration(['preparing','ready']), source_path: relative,
  source_revision: revision, draft_path: relative, draft_revision: revision, intent: text, model: text, items: Type.Array(ChangeSetItemSchema, { maxItems: 100 }) });
export type ChangeSet = Static<typeof ChangeSetSchema>;
export const CandidateDocumentSchema = object({ changeset_id: uuid, item: ChangeSetItemSchema, current: nullable(text), current_revision: nullable(revision), content: text, revision });
export type CandidateDocument = Static<typeof CandidateDocumentSchema>;
export const CandidateSaveSchema = object({ request_id: uuid, changeset_id: uuid, item_id: uuid, revision, content: Type.String({ maxLength: 5 * 1024 * 1024 }) });
export type CandidateSave = Static<typeof CandidateSaveSchema>;
export const PlannerTemplateWriteSchema = object({ revision, content: Type.String({ minLength: 1, maxLength: 64000 }) });
export const PlanningIdSchema = object({ id: uuid });
export const CandidateQuerySchema = object({ id: uuid, item_id: uuid });
export const ChangeSetDecisionSchema = object({ item_id: uuid, decision: enumeration(['undecided','include','reject']), domain_approved: Type.Boolean() });
export const ChangeSetReviewSchema = object({ changeset_id: uuid, manifest_revision: revision, revision,
  decisions: Type.Array(ChangeSetDecisionSchema, { maxItems: 100 }) });
export type ChangeSetReview = Static<typeof ChangeSetReviewSchema>;
export const ReviewSaveSchema = object({ changeset_id: uuid, manifest_revision: revision, revision,
  decisions: Type.Array(ChangeSetDecisionSchema, { maxItems: 100 }) });
export const ChangeSetApprovalSchema = object({ request_id: uuid, changeset_id: uuid, manifest_revision: revision, review_revision: revision,
  source_revision: revision, draft_path: relative, related_drafts: Type.Array(object({ path: relative, revision }), { minItems: 1, maxItems: 100 }),
  items: Type.Array(object({ item_id: uuid, candidate_revision: nullable(revision), current_revision: nullable(revision) }), { minItems: 1, maxItems: 100 }) });
export type ChangeSetApproval = Static<typeof ChangeSetApprovalSchema>;
export const IntegrationJobSchema = object({ id: uuid, kind: Type.Literal('apply_integration'), status: enumeration(['running','succeeded','failed','interrupted']),
  created_at: instant, started_at: instant, finished_at: nullable(instant), changeset_id: nullable(uuid), source_path: relative,
  target_paths: Type.Array(relative), completed_paths: Type.Array(relative), discarded_drafts: Type.Array(relative), error });
export type IntegrationJob = Static<typeof IntegrationJobSchema>;
export const ChangeSetInspectionSchema = object({ manifest_revision: revision, review: ChangeSetReviewSchema, source_revision: revision, selected_draft: nullable(relative),
  related_drafts: Type.Array(object({ path: relative, revision })),
  targets: Type.Array(object({ item_id: uuid, current: nullable(text), current_revision: nullable(revision), candidate_revision: nullable(revision) })) });
export type ChangeSetInspection = Static<typeof ChangeSetInspectionSchema>;
export const PLANNING_API = {
  settings: { method: 'GET', url: '/v1/planner/settings', schema: { querystring: object({}), response: { 200: object({ settings: PlannerSettingsSchema }) } } },
  settingsWrite: { method: 'POST', url: '/v1/planner/settings', schema: { querystring: object({}), body: object({ settings: PlannerSettingsSchema }), response: { 200: object({ settings: PlannerSettingsSchema }) } } },
  template: { method: 'GET', url: '/v1/planner/template', schema: { querystring: object({}), response: { 200: object({ content: text, revision, relation: nullable(object({ path: relative, content: text, revision })) }) } } },
  templateWrite: { method: 'POST', url: '/v1/planner/template', schema: { querystring: object({}), body: PlannerTemplateWriteSchema, response: { 200: object({ content: text, revision }) } } },
  plan: { method: 'POST', url: '/v1/plans', schema: { querystring: object({}), body: PlanRequestSchema, response: { 202: object({ job: PlannerJobSchema, reused: Type.Boolean() }) } } },
  planCancel: { method: 'POST', url: '/v1/plans/cancel', schema: { querystring: object({}), body: PlanningIdSchema, response: { 200: PlannerJobSchema } } },
  changesets: { method: 'GET', url: '/v1/changesets', schema: { querystring: object({ source_path: Type.Optional(relative) }), response: { 200: object({ items: Type.Array(ChangeSetSchema) }) } } },
  changeset: { method: 'GET', url: '/v1/changeset', schema: { querystring: PlanningIdSchema, response: { 200: object({ manifest: ChangeSetSchema, revision }) } } },
  candidate: { method: 'GET', url: '/v1/changeset/candidate', schema: { querystring: CandidateQuerySchema, response: { 200: CandidateDocumentSchema } } },
  candidateSave: { method: 'POST', url: '/v1/changeset/candidate', schema: { querystring: object({}), body: CandidateSaveSchema, response: { 200: object({ revision }) } } },
  changesetCancel: { method: 'POST', url: '/v1/changeset/cancel', schema: { querystring: object({}), body: PlanningIdSchema, response: { 200: ChangeSetSchema } } },
  review: { method: 'GET', url: '/v1/changeset/review', schema: { querystring: PlanningIdSchema, response: { 200: ChangeSetInspectionSchema } } },
  reviewSave: { method: 'POST', url: '/v1/changeset/review', schema: { querystring: object({}), body: ReviewSaveSchema, response: { 200: ChangeSetReviewSchema } } },
  approve: { method: 'POST', url: '/v1/changeset/approve', schema: { querystring: object({}), body: ChangeSetApprovalSchema, response: { 200: object({ job: IntegrationJobSchema, reused: Type.Boolean() }) } } },
  execution: { method: 'GET', url: '/v1/integration', schema: { querystring: PlanningIdSchema, response: { 200: object({ job: nullable(IntegrationJobSchema) }) } } },
  integrationFile: { method: 'GET', url: '/v1/integration/file', schema: { querystring: object({ id: uuid, path: relative }), response: { 200: object({ path: relative, revision }) } } },
} as const;
