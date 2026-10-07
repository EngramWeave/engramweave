import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { httpRuntime, finishedJob, submitScan } from '../helpers/http.js';
import { submitCapture } from '../helpers/capture.js';
import { pendingSample, manualSource, realBytes, realSamples, sha256 } from '../helpers/fixtures.js';
import { LIMITS } from '@engramweave/contracts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('authenticated Raw Source Capture and explicit indexing', () => {
  it('saves genuine web bytes and archived manual bytes, replays idempotently, and indexes only on explicit scan', async () => {
    const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
    const sample = realSamples[0]!; const raw = await realBytes(sample.path);
    const web = await submitCapture(request, '20_Sources/API/web.md', raw.toString('utf8'));
    expect(web).toEqual({ status: 201, body: { path: '20_Sources/API/web.md', revision: sample.hash, created: true, scan_required: true } });
    expect(await readFile(path.join(config.vault_path, web.body.path))).toEqual(raw);
    const manual = manualSource('manualcaptureword 中文', 'processing_status: archived\nannotation: API context\n');
    const saved = await submitCapture(request, '20_Sources/API/manual.md', manual);
    expect(saved).toMatchObject({ status: 201, body: { created: true, scan_required: true } });
    expect(await submitCapture(request, web.body.path, raw.toString('utf8'))).toMatchObject({ status: 200, body: { created: false, revision: sample.hash } });
    expect(await (await request('/v1/status')).json()).toMatchObject({ index_generation: 0, counts: { sources: 0 }, active_job: null });
    expect(await (await request('/v1/search?scope=sources&q=manualcaptureword')).json()).toMatchObject({ total: 0 });
    expect(await (await request('/v1/jobs')).json()).toMatchObject({ total: 0 });
    expect(await (await request('/v1/documents?path=20_Sources/API/manual.md')).json()).toMatchObject({ index_stale: true, processing_status: 'archived', source_content: 'manualcaptureword 中文', annotation: 'API context' });
    const scan = await submitScan(request); const job = await finishedJob(request, scan.job.id);
    expect(job).toMatchObject({ status: 'succeeded', summary: { added: 2 } });
    const search = await (await request('/v1/search?scope=sources&q=manualcaptureword')).json(); expect(search.total).toBe(1);
    expect(sha256(await readFile(path.join(config.vault_path, web.body.path)))).toBe(sha256(await pendingSample(sample)));
    if (process.env.P1_EVIDENCE === '1') {
      await mkdir('.local/p1/evidence', { recursive: true });
      await writeFile('.local/p1/evidence/t09-capture-api.json', JSON.stringify({ web, saved, job, search, web_file_sha256: sample.hash, manual_file_sha256: sha256(Buffer.from(manual)) }, null, 2));
    }
  }, 30_000);

  it('rejects untrusted targets and invalid Source inputs before creating parent directories', async () => {
    const { request, config, root, cleanup } = await httpRuntime(); cleanups.push(cleanup);
    for (const [relative, markdown, status] of [
      ['40_Knowledge/note.md', manualSource(), 400], ['20_Sources/../escaped.md', manualSource(), 400], ['20_Sources/CON.md', manualSource(), 403],
      ['20_Sources/.hidden/note.md', manualSource(), 403], ['20_Sources/new/plain.md', '# Not a Raw Source', 422],
      ['20_Sources/new/paper.md', manualSource().replace('source_type: manual', 'source_type: paper'), 422],
      ['20_Sources/new/empty.md', manualSource('  '), 422], ['20_Sources/new/invalid.md', manualSource('body', 'annotation: [bad]\n'), 422],
      ['20_Sources/new/asset.source.md', manualSource('description', 'asset: "[[./file.pdf]]"\n'), 422],
    ] as const) expect((await submitCapture(request, relative, markdown)).status, relative).toBe(status);
    const bad = await request('/v1/captures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '20_Sources/new/note.md', markdown: 123 }) });
    expect(bad.status).toBe(400);
    const unknown = await request('/v1/captures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '20_Sources/new/note.md', markdown: manualSource(), extra: true }) });
    expect(unknown.status).toBe(400);
    expect((await request('/v1/captures', { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ path: '20_Sources/new/note.md', markdown: manualSource() }) })).status).toBe(401);
    expect(await readdir(config.vault_path)).toEqual([]);
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await mkdir(path.join(config.vault_path, '20_Sources'));
    await symlink(outside, path.join(config.vault_path, '20_Sources/link'), 'junction');
    expect((await submitCapture(request, '20_Sources/link/note.md', manualSource())).status).toBe(403);
    expect(await readdir(outside)).toEqual([]);
  });

  it('enforces Markdown and JSON limits in bytes, including multibyte text', async () => {
    const { request, config, cleanup } = await httpRuntime(); cleanups.push(cleanup);
    expect((await submitCapture(request, '20_Sources/large.md', manualSource('中'.repeat(Math.ceil(LIMITS.markdown_bytes / 3))))).status).toBe(413);
    expect((await submitCapture(request, '20_Sources/json-large.md', 'x'.repeat(LIMITS.capture_json_bytes))).status).toBe(413);
    const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest(`http://127.0.0.1:${config.port}/v1/captures`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      outgoing.once('error', reject);
      outgoing.write('{"path":"20_Sources/chunked.md","markdown":"');
      for (let index = 0; index < 33; index++) outgoing.write('x'.repeat(256 * 1024));
      outgoing.end('"}');
    });
    expect(chunked).toBe(413);
    expect(await readdir(config.vault_path)).toEqual([]);
    const header = manualSource('');
    const maximum = `${header}${'x'.repeat(LIMITS.markdown_bytes - Buffer.byteLength(header))}`;
    expect((await submitCapture(request, '20_Sources/maximum.md', maximum)).status).toBe(201);
    expect((await lstat(path.join(config.vault_path, '20_Sources/maximum.md'))).size).toBe(LIMITS.markdown_bytes);
  });
});
