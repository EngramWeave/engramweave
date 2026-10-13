import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { RESOURCE_API } from '@engramweave/contracts';
import { integrationFixture } from '../helpers/integration.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { createHttp } from '../../packages/core/src/http.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';

async function fixture() {
  const f = await integrationFixture(); const jobs = new ScanJobs(f.db, f.config.vault_path, () => false);
  const server = createHttp(f.config, { token: 'fixture', status: 'ready' }, () => ({ db: f.db, jobs, humanReview: f.human, planner: f.planner, integration: f.execution, analyzer: f.analyzer, instance_id: 'fixture' }));
  const headers = { host: `127.0.0.1:${f.config.port}`, authorization: 'Bearer fixture' };
  return { ...f, server, get: (url: string) => server.inject({ method: 'GET', url, headers }), async close() { await server.close(); await jobs.close(); await f.close(); } };
}
it('lists actual Draft files with discarded and invalid files, one selected identity, stable paging and no body payload', async () => {
  const f = await fixture();
  try {
    const bytes = await readFile(path.join(f.config.vault_path, f.draftPath), 'utf8');
    await writeFile(path.join(f.config.vault_path, '30_Drafts/other.md'), bytes);
    await writeFile(path.join(f.config.vault_path, '30_Drafts/discarded.md'), bytes.replace('lifecycle_status: active', 'lifecycle_status: discarded'));
    await writeFile(path.join(f.config.vault_path, '30_Drafts/broken.md'), 'Malformed Draft Properties');
    const response = await f.get('/v1/review-files'); expect(response.statusCode).toBe(200); expect(Value.Check(RESOURCE_API.review.schema.response[200], response.json())).toBe(true);
    expect(response.json().total).toBe(3); expect(response.json().views).toMatchObject({ planned: 1, discarded: 1, issues: 1, to_review: 0 });
    expect(response.json().items.filter((item: { selected: boolean }) => item.selected)).toHaveLength(1); expect(response.body).not.toContain('The effect always holds');
    const discarded = await f.get('/v1/review-files?view=discarded'); expect(discarded.json().items[0].path).toBe('30_Drafts/discarded.md');
    const page = await f.get('/v1/review-files?limit=1&offset=1'); expect(page.json().total).toBe(3); expect(page.json().items).toHaveLength(1);
    expect((await f.get('/v1/review-files?q=other.md')).json().total).toBe(1);
    const focused = await f.get('/v1/review-files?path=30_Drafts/other.md'); expect(focused.json().total).toBe(1); expect(focused.json().views.all).toBe(3);
    expect((await f.get('/v1/review-files?stages=planned')).json().total).toBe(2);
    for (const view of ['all', 'to_review', 'reviewed', 'planned', 'issues', 'discarded']) {
      const baseline = (await f.get(`/v1/review-files?view=${view}`)).json();
      expect((await f.get(`/v1/review-files?view=${view}&stages=`)).json()).toEqual(baseline);
      expect((await f.get(`/v1/review-files?view=${view}&stages=%20,%20`)).json()).toEqual(baseline);
    }
    await unlink(path.join(f.config.vault_path, f.sourcePath));
    expect((await f.get('/v1/review-files?view=issues')).json().total).toBe(3);
    expect((await f.get('/v1/review-files?view=planned')).json().total).toBe(0);
    expect((await f.get('/v1/draft/file?path=30_Drafts/broken.md')).statusCode).toBe(200);
    expect((await f.get('/v1/draft/file?path=90_System/private.md')).statusCode).toBe(403);
    expect((await f.get('/v1/review-files?limit=101')).statusCode).toBe(400);
    expect((await f.server.inject({ method: 'GET', url: '/v1/review-files', headers: { host: `127.0.0.1:${f.config.port}` } })).statusCode).toBe(401);
  } finally { await f.close(); }
});
it('keeps bad workspaces local, filters live proposals by target, and removes consumed proposals from Changes', async () => {
  const f = await fixture();
  try {
    const bad = randomUUID(); const directory = path.join(f.config.vault_path, '70_ChangeSets', bad);
    await mkdir(directory); await writeFile(path.join(directory, 'manifest.json'), 'broken');
    const response = await f.get('/v1/change-files'); expect(response.statusCode).toBe(200); expect(Value.Check(RESOURCE_API.changes.schema.response[200], response.json())).toBe(true);
    expect(response.json().views).toMatchObject({ all: 2, ready: 1, issues: 1 });
    expect((await f.get('/v1/change-files?q=Integrated.md&domain=40_Knowledge&kind=write')).json().items[0].id).toBe(f.id);
    expect((await f.get(`/v1/changeset/overview?id=${f.id}`)).json().review.decisions).toHaveLength(1);
    await f.choose(); await f.execution.approve(await f.approval());
    const after = await f.get('/v1/change-files'); expect(after.json().items).toHaveLength(1); expect(after.json().items[0].id).toBe(bad);
    expect(f.execution.all()[0]?.status).toBe('succeeded');
  } finally { await f.close(); }
});
it('shows accepted interrupted execution as protected even though its manifest remains ready', async () => {
  const f = await fixture(); const original = PropertyNative.prototype.run;
  const mock = vi.spyOn(PropertyNative.prototype, 'run').mockImplementation(function (this: PropertyNative, ...args) {
    if (args[1] === f.sourcePath && !args[6] && !args[10]) throw new CoreError('IO_ERROR', 'Injected archival interruption'); return original.apply(this, args);
  });
  try {
    await f.choose(); expect((await f.execution.approve(await f.approval())).job.status).toBe('failed');
    const response = await f.get('/v1/change-files?view=executing'); expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ state: 'executing', can_cancel: false, execution_status: 'failed' });
    expect((await f.get(`/v1/changeset/overview?id=${f.id}`)).json().review).toBeNull();
    expect((await f.get('/v1/change-files?view=ready')).json().total).toBe(0);
  } finally { mock.mockRestore(); await f.close(); }
});
it('cancels a valid proposal without being blocked by an unrelated malformed workspace', async () => {
  const f = await fixture();
  try {
    const bad = randomUUID(); const directory = path.join(f.config.vault_path, '70_ChangeSets', bad); await mkdir(directory); await writeFile(path.join(directory, 'manifest.json'), 'broken');
    expect((await f.get(`/v1/changesets?source_path=${encodeURIComponent(f.sourcePath)}`)).json().items[0].id).toBe(f.id);
    await f.planner.cancelChangeSet(f.id);
    expect(await readFile(path.join(f.config.vault_path, f.sourcePath), 'utf8')).toContain('processing_status: reviewed');
    const response = await f.get('/v1/change-files'); expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([bad]);
    expect(await f.human.selection(f.sourcePath)).toBe(f.draftPath);
  } finally { await f.close(); }
});
