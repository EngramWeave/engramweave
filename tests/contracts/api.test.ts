import { describe, expect, it } from 'vitest';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { API, CaptureRequestSchema, DocumentSchema, JobSchema, ProcessingStatusSchema, LifecycleStatusSchema, PROCESSING_STATUSES, SearchQuerySchema, VaultPathSchema } from '@engramweave/contracts';
import type { Document, Job } from '@engramweave/contracts';

describe('frozen P1 contracts', () => {
  it('compiles every request and response schema for runtime use', () => {
    expect(Object.keys(API)).toHaveLength(9);
    for (const route of Object.values(API)) {
      for (const [name, schema] of Object.entries(route.schema)) {
        if (name === 'response') for (const response of Object.values(schema as Record<string, TSchema>)) expect(TypeCompiler.Compile(response)).toBeDefined();
        else expect(TypeCompiler.Compile(schema)).toBeDefined();
      }
    }
  });
  it('accepts only scan_vault jobs and rejects unknown capture fields and non-Source targets', () => {
    const job: Job = { id: 'opaque', kind: 'scan_vault', mode: 'refresh', status: 'queued', created_at: '2026-10-04T00:00:00+08:00', started_at: null, finished_at: null, processed_files: 0, summary: null, error: null };
    expect(Value.Check(JobSchema, job)).toBe(true);
    expect(Value.Check(JobSchema, { ...job, kind: 'compile' })).toBe(false);
    expect(Value.Check(CaptureRequestSchema, { path: '20_Sources/manual.md', markdown: 'content' })).toBe(true);
    expect(Value.Check(CaptureRequestSchema, { path: '40_Knowledge/k.md', markdown: 'content' })).toBe(false);
    expect(Value.Check(CaptureRequestSchema, { path: '20_Sources/manual.md', markdown: 'content', provider: 'extra' })).toBe(false);
  });
  it.each(['../x.md', '20_Sources/../x.md', 'C:/x.md', '//host/x.md', '20_Sources/x.md:stream', '20_Sources\\x.md', '/20_Sources/x.md', '20_Sources//x.md'])('rejects forbidden lexical path %s', value => {
    expect(Value.Check(VaultPathSchema, value)).toBe(false);
  });
  it('preserves source_content, Annotation, metadata and Knowledge body as separate fields', () => {
    const document: Document = {
      kind: 'source', path: '20_Sources/web.md', record_path: '20_Sources/web.md', title: 'Web',
      revision: 'a'.repeat(64), indexed_revision: null, indexed_at: null, index_generation: 0, index_stale: true,
      metadata: { description: 'extension', author: ['Name'], published: '2026-10-03' },
      annotation: '', diagnostics: [], original_references: [], source_type: 'web',
      original_locator: 'https://example.com', captured_at: '2026-10-03', processing_status: null, lifecycle_status: 'active', body: null,
      asset: { kind: 'inline_markdown', locator: '20_Sources/web.md', availability: 'available' },
      source_content: 'Original body', record_body: null,
    };
    expect(Value.Check(DocumentSchema, document)).toBe(true);
    expect(Value.Check(DocumentSchema, { ...document, body: 'Duplicated body' })).toBe(false);
    expect(Value.Check(DocumentSchema, { ...document, record_body: 'Asset text' })).toBe(false);
    expect(Value.Check(DocumentSchema, { ...document, asset: { ...document.asset, kind: 'vault_file' } })).toBe(false);
    expect(Value.Check(DocumentSchema, { ...document, processing_status: 'archived' })).toBe(true);
    expect(Value.Check(DocumentSchema, { ...document, processing_status: 'ready' })).toBe(false);
    const record = { ...document, asset: { kind: 'vault_file', locator: '20_Sources/asset.pdf', availability: 'unsupported' }, source_content: null, record_body: 'Record notes', processing_status: 'archived' };
    expect(Value.Check(DocumentSchema, record)).toBe(true);
  });
  it('requires explicit independent stage and lifecycle properties', () => {
    expect(Value.Check(ProcessingStatusSchema, null)).toBe(true);
    expect(Value.Check(ProcessingStatusSchema, 'archived')).toBe(true);
    for (const stage of PROCESSING_STATUSES) expect(Value.Check(ProcessingStatusSchema, stage)).toBe(true);
    for (const lifecycle of ['active', 'discarded', null]) expect(Value.Check(LifecycleStatusSchema, lifecycle)).toBe(true);
    for (const invalid of ['pending', 'failed', true, undefined]) expect(Value.Check(LifecycleStatusSchema, invalid)).toBe(false);
    for (const value of [undefined, '', 'ready', 'running', true, ['archived']]) expect(Value.Check(ProcessingStatusSchema, value)).toBe(false);
  });
  it('freezes search limits, fields and pagination boundaries', () => {
    expect(Value.Check(SearchQuerySchema, { q: 'counter++', scope: 'sources', fields: 'body,annotation', limit: 20, offset: 0 })).toBe(true);
    for (const invalid of [{ fields: 'description' }, { limit: 101 }, { offset: -1 }, { q: 'x'.repeat(201) }, { unknown: true }]) {
      expect(Value.Check(SearchQuerySchema, invalid)).toBe(false);
    }
  });
});
