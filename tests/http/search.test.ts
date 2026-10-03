import { afterEach, describe, expect, it } from 'vitest';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const result = await httpRuntime(async vault => {
    await writeDocument(vault, '20_Sources/plain.md', manualSource('Cafe\u0301 中文 % _ counter++ factword', 'title: Example\nannotation: 用户上下文 contextword\ntags: [CAFÉ, tagone]\ndescription: extensiononly\nsource: https://example.com/original\n'));
    await writeDocument(vault, '20_Sources/paper.md', manualSource('factword', 'title: Paper\n').replace('source_type: manual', 'source_type: paper'));
    await writeDocument(vault, '40_Knowledge/K1.md', '# Existing knowledge\n\nfactword 中文');
  });
  cleanups.push(result.cleanup);
  const submitted = await submitScan(result.request); await finishedJob(result.request, submitted.job.id);
  return result;
}

describe('literal field-aware search and current detail reads', () => {
  it('matches Unicode, Chinese, symbols and AND across selected fields without indexing descriptions', async () => {
    const { request } = await fixture();
    for (const query of ['q=CAF%C3%89&fields=body', `q=${encodeURIComponent('中文 %')}&fields=body`, 'q=counter%2B%2B&fields=body', 'q=factword%20contextword&fields=body,annotation']) {
      expect(await (await request(`/v1/search?scope=sources&${query}`)).json()).toMatchObject({ total: 1 });
    }
    expect(await (await request('/v1/search?scope=sources&q=extensiononly&fields=metadata')).json()).toMatchObject({ total: 0 });
    expect(await (await request('/v1/search?scope=sources&q=contextword&fields=body')).json()).toMatchObject({ total: 0 });
    const context = await (await request('/v1/search?scope=sources&q=contextword&fields=annotation')).json();
    expect(context.items[0]).toMatchObject({ matched_fields: ['annotation'], snippet_field: 'annotation', snippet_context: 'user_context' });
    const metadata = await (await request('/v1/search?scope=sources&q=original&fields=metadata')).json();
    expect(metadata.items[0].snippet).toBe('https://example.com/original');
    expect(await (await request(`/v1/search?scope=sources&q=${encodeURIComponent("' OR 1=1")}`)).json()).toMatchObject({ total: 0 });
  });
  it('defaults to Knowledge, prioritizes Knowledge then paper, and filters tags and path segments', async () => {
    const { request } = await fixture();
    expect(await (await request('/v1/search?q=factword')).json()).toMatchObject({ total: 1 });
    const all = await (await request('/v1/search?q=factword&scope=all&limit=2')).json();
    expect(all).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(all.items.map((item: { kind: string; source_type: string }) => [item.kind, item.source_type])).toEqual([['knowledge', null], ['source', 'paper']]);
    expect(await (await request('/v1/search?scope=sources&tag=caf%C3%A9')).json()).toMatchObject({ total: 1 });
    expect(await (await request('/v1/search?scope=sources&path_prefix=20_Sources')).json()).toMatchObject({ total: 2 });
    expect(await (await request('/v1/search?scope=sources&path_prefix=20_Source')).json()).toMatchObject({ total: 0 });
    for (const query of ['', '?q=one%20two%20three%20four%20five%20six%20seven%20eight%20nine', '?q=word&fields=invalid', '?q=word&extra=1', '?q=word&limit=101']) {
      expect((await request(`/v1/search${query}`)).status).toBe(400);
    }
  });
  it('reads current Markdown independently of the preceding indexed body, including before the first scan', async () => {
    const { request, config } = await fixture();
    await writeDocument(config.vault_path, '20_Sources/plain.md', manualSource('newterm current body', 'annotation: changed context\n'));
    const changed = await (await request('/v1/documents?path=20_Sources/plain.md')).json();
    expect(changed).toMatchObject({ index_stale: true, source_content: 'newterm current body', annotation: 'changed context' });
    expect(changed.revision).not.toBe(changed.indexed_revision);
    expect(await (await request('/v1/search?scope=sources&q=newterm')).json()).toMatchObject({ total: 0 });
    await writeDocument(config.vault_path, '20_Sources/new.md', manualSource('unindexed body'));
    expect(await (await request('/v1/documents?path=20_Sources/new.md')).json()).toMatchObject({ indexed_revision: null, indexed_at: null, index_stale: true });
    const submitted = await submitScan(request); await finishedJob(request, submitted.job.id);
    expect(await (await request('/v1/documents?path=20_Sources/plain.md')).json()).toMatchObject({ index_stale: false });
    expect(await (await request('/v1/search?scope=sources&q=newterm')).json()).toMatchObject({ total: 1 });
    expect((await request('/v1/documents?path=20_Sources/missing.md')).status).toBe(404);
    expect((await request('/v1/documents?path=30_Drafts/secret.md')).status).toBe(400);
  });
});
