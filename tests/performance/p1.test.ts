import { expect, it } from 'vitest';
import { cpus, totalmem, release } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';
import { standaloneCore } from '../helpers/cli.js';
import { finishedJob, submitScan } from '../helpers/http.js';
import { copyRealSamples, realSamples, sha256, writeDocument, manualSource } from '../helpers/fixtures.js';

// Explicit opt-in keeps machine-dependent timing out of ordinary regression runs.
it.skipIf(process.env.P1_PERFORMANCE !== '1')('measures 500 Markdown files / 25 MiB through standalone HTTP without changing assets', async () => {
  const isolated = await isolatedRuntime();
  const count = 500;
  const totalBytes = 25 * 1024 * 1024;
  const sizes = new Map<string, number>();
  const hashes = new Map<string, string>();
  let core: Awaited<ReturnType<typeof standaloneCore>> | undefined;
  try {
    await copyRealSamples(isolated.config.vault_path);
    for (const sample of realSamples) {
      const bytes = await readFile(path.join(isolated.config.vault_path, sample.path));
      expect(sha256(bytes)).toBe(sample.hash);
      sizes.set(sample.path, bytes.length);
      hashes.set(sample.path, sample.hash);
    }
    const filler = 'common benchmark text with 中文内容 and literal symbols counter++ volatile.\n';
    for (let index = 2; index < count; index++) {
      const knowledge = index >= 400;
      const relative = `${knowledge ? '40_Knowledge' : '20_Sources'}/Benchmark/item-${String(index).padStart(3, '0')}.md`;
      const header = knowledge
        ? `---\ntags: [benchmark]\n---\n# Existing knowledge ${index}\nunique-${index}\n`
        : manualSource(`unique-${index}\n`, `title: Benchmark ${index}\ntags: [benchmark]\nannotation: User context ${index}\n`);
      const allocated = [...sizes.values()].reduce((sum, size) => sum + size, 0);
      const size = index === count - 1 ? totalBytes - allocated : Math.floor(totalBytes / count);
      const bytes = Buffer.alloc(size, 0x20);
      Buffer.from(header + filler.repeat(Math.floor((size - Buffer.byteLength(header)) / Buffer.byteLength(filler)))).copy(bytes);
      await writeDocument(isolated.config.vault_path, relative, bytes);
      sizes.set(relative, bytes.length);
      hashes.set(relative, sha256(bytes));
    }
    expect(sizes.size).toBe(count);
    expect([...sizes.values()].reduce((sum, size) => sum + size, 0)).toBe(totalBytes);
    core = await standaloneCore(isolated.root, isolated.config);
    const scans = [];
    for (const mode of ['refresh', 'refresh', 'rebuild'] as const) {
      const start = performance.now();
      const submitted = await submitScan(core.request, mode);
      expect(submitted.status).toBe(202);
      const job = await finishedJob(core.request, submitted.job.id);
      const duration = performance.now() - start;
      expect(job).toMatchObject({ status: 'succeeded', processed_files: count, summary: { source_count: 400, knowledge_count: 100, invalid: 0, unsupported: 0 } });
      scans.push({ mode, elapsed_ms: duration, summary: job.summary });
    }
    const cases = [
      { name: 'selective-body', route: '/v1/search?scope=all&q=unique-499&fields=body', total: 1 },
      { name: 'broad-body', route: '/v1/search?scope=all&q=common&fields=body', total: 498 },
      { name: 'multi-term', route: '/v1/search?scope=sources&q=volatile%20counter%2B%2B&fields=body', total: 399 },
      { name: 'annotation', route: '/v1/search?scope=sources&q=User%20context&fields=annotation', total: 398 },
      { name: 'metadata-filter', route: '/v1/search?scope=all&tag=benchmark', total: 498 },
    ];
    const queries = [];
    for (const query of cases) {
      const timings: number[] = [];
      for (let iteration = 0; iteration < 33; iteration++) {
        const start = performance.now();
        const response = await core.request(query.route);
        expect(response.status).toBe(200);
        const result = await response.json();
        const elapsed = performance.now() - start;
        expect(result.total, query.name).toBe(query.total);
        expect(result.index_generation).toBe(3);
        if (iteration >= 3) timings.push(elapsed);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      queries.push({ ...query, warmup: 3, measured_requests: timings.length, p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max_ms: sorted.at(-1)!, timings_ms: timings });
    }
    const afterHashes = [];
    for (const [relative, expected] of hashes) {
      const actual = sha256(await readFile(path.join(isolated.config.vault_path, relative)));
      expect(actual, relative).toBe(expected);
      afterHashes.push({ path: relative, bytes: sizes.get(relative), before_sha256: expected, after_sha256: actual });
    }
    await core.close(); core = undefined;
    const evidence = {
      run_at: new Date().toISOString(), machine: { platform: process.platform, os_release: release(), arch: process.arch, cpu: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem(), node: process.version },
      conditions: { filesystem: 'local NTFS (T00 environment)', candidates: count, markdown_bytes: totalBytes, sources: 400, knowledge: 100, fixture_origin: '2 unchanged private R1 files + 498 explicitly constructed benchmark files', concurrent_test_workers: 1, scan_timing: 'HTTP submit through succeeded Job polling (25ms interval), excludes fixture creation and Core startup', query_timing: 'real loopback HTTP through JSON decode, sequential warm queries', cache: 'OS cache not flushed; initial refresh is not a cold-disk guarantee' },
      scans, queries, asset_hashes: afterHashes,
      targets: { scan_ms: 15_000, query_p95_ms: 1_000 },
      passed: scans.every(scan => scan.elapsed_ms <= 15_000) && queries.every(query => query.p95_ms <= 1_000),
    };
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile('.local/p1/evidence/t13-performance.json', `${JSON.stringify(evidence, null, 2)}\n`);
    for (const scan of scans) expect(scan.elapsed_ms, `${scan.mode} scan`).toBeLessThanOrEqual(15_000);
    for (const query of queries) expect(query.p95_ms, query.name).toBeLessThanOrEqual(1_000);
  } finally {
    if (core) await core.close();
    await isolated.cleanup();
  }
}, 180_000);
