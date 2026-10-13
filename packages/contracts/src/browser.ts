import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ChangeSetSchema, ChangeSetReviewSchema } from './planning.js';

const object = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const choices = <T extends string>(values: readonly T[]) => Type.Union(values.map(value => Type.Literal(value)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const text = Type.String();
const path = Type.String({ minLength: 1, maxLength: 2048 });
const revision = Type.String({ pattern: '^[a-f0-9]{64}$' });
const diagnostic = object({ code: text, message: text });
const stage = choices(['pending', 'compiled', 'reviewed', 'planned', 'archived']);
const lifecycle = choices(['active', 'discarded']);
const pagination = { q: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) };
export const REVIEW_VIEWS = ['all', 'to_review', 'reviewed', 'planned', 'issues', 'discarded'] as const;
export const CHANGE_VIEWS = ['all', 'preparing', 'ready', 'executing', 'issues'] as const;
export const ANALYSIS_STATES = ['none', 'running', 'complete', 'partial', 'failed', 'stale'] as const;
export const ReviewBrowserQuerySchema = object({ ...pagination, view: Type.Optional(choices(REVIEW_VIEWS)), path: Type.Optional(path), stages: Type.Optional(text), analysis: Type.Optional(choices(ANALYSIS_STATES)), source_path: Type.Optional(path), sort: Type.Optional(choices(['title_asc', 'updated_desc', 'updated_asc'])) });
export type ReviewBrowserQuery = Static<typeof ReviewBrowserQuerySchema>;
export const ReviewFileSchema = object({ path, title: text, revision: nullable(revision), updated_at: nullable(text), lifecycle_status: nullable(lifecycle),
  source_path: nullable(path), source_title: nullable(text), source_revision: nullable(revision), source_stage: nullable(stage), source_lifecycle: nullable(lifecycle), selected: Type.Boolean(),
  analysis: choices(ANALYSIS_STATES), diagnostics: Type.Array(diagnostic) });
export type ReviewFile = Static<typeof ReviewFileSchema>;
const counts = (views: readonly string[]) => object(Object.fromEntries(views.map(view => [view, Type.Integer({ minimum: 0 })])));
export const ReviewBrowserPageSchema = object({ items: Type.Array(ReviewFileSchema), total: Type.Integer({ minimum: 0 }), views: counts(REVIEW_VIEWS) });
export const ChangeBrowserQuerySchema = object({ ...pagination, view: Type.Optional(choices(CHANGE_VIEWS)), source_path: Type.Optional(path), kind: Type.Optional(choices(['write', 'directory', 'discard'])), domain: Type.Optional(choices(['10_Ideas', '40_Knowledge', '50_Research', '60_Projects'])), sort: Type.Optional(choices(['created_desc', 'created_asc', 'title_asc'])) });
export type ChangeBrowserQuery = Static<typeof ChangeBrowserQuerySchema>;
export const ChangeFileSchema = object({ id: text, path, title: text, source_path: nullable(path), draft_path: nullable(path), created_at: nullable(text), state: choices(['preparing', 'ready', 'executing', 'issues']),
  impact: object({ write: Type.Integer({ minimum: 0 }), directory: Type.Integer({ minimum: 0 }), discard: Type.Integer({ minimum: 0 }) }),
  planner_job: nullable(text), execution_id: nullable(text), execution_status: nullable(text), can_cancel: Type.Boolean(), diagnostics: Type.Array(diagnostic) });
export type ChangeFile = Static<typeof ChangeFileSchema>;
export const ChangeBrowserPageSchema = object({ items: Type.Array(ChangeFileSchema), total: Type.Integer({ minimum: 0 }), views: counts(CHANGE_VIEWS) });
export const RESOURCE_API = {
  review: { method: 'GET', url: '/v1/review-files', schema: { querystring: ReviewBrowserQuerySchema, response: { 200: ReviewBrowserPageSchema } } },
  changes: { method: 'GET', url: '/v1/change-files', schema: { querystring: ChangeBrowserQuerySchema, response: { 200: ChangeBrowserPageSchema } } },
  overview: { method: 'GET', url: '/v1/changeset/overview', schema: { querystring: object({ id: text }), response: { 200: object({ manifest: ChangeSetSchema, review: nullable(ChangeSetReviewSchema) }) } } },
  draftFile: { method: 'GET', url: '/v1/draft/file', schema: { querystring: object({ path }), response: { 200: object({ path, revision }) } } },
} as const;
