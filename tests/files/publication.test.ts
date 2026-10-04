import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { enumerateMarkdown } from '../../packages/core/src/discovery/scan.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { faultChild } from '../helpers/fault-child.js';
import { manualSource, sha256 } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
const evidence: Record<string, unknown>[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (process.env.P1_EVIDENCE === '1') {
    await mkdir('.local/p1/evidence', { recursive: true });
    await writeFile('.local/p1/evidence/d07-publication.json', JSON.stringify({ platform: process.platform, node: process.version, cases: evidence }, null, 2));
  }
});
async function fixture() {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  const directory = path.join(isolated.config.vault_path, '20_Sources'); await mkdir(directory);
  const start = (bytes: Buffer, phase: string) => {
    const child = faultChild(path.resolve('tests/helpers/file-publication-child.mjs'), [directory, bytes.toString('base64'), phase]);
    cleanups.push(child.kill); return child;
  };
  return { ...isolated, directory, target: path.join(directory, 'published.md'), start };
}

describe('D07 Windows local NTFS no-replace hard-link publication', () => {
  it('admits exactly one of eight independent concurrent publishers and keeps the complete winner bytes', async () => {
    const { directory, target, start } = await fixture();
    const payloads = Array.from({ length: 8 }, (_, index) => Buffer.from(manualSource(`Publisher ${index}\n${'complete-content\n'.repeat(1000)}`)));
    const children = payloads.map(bytes => start(bytes, 'race'));
    await Promise.all(children.map(child => child.phase('flushed')));
    expect(await readdir(directory)).toHaveLength(8);
    children.forEach(child => child.release());
    const results = await Promise.all(children.map(child => child.phase('done')));
    expect(results.filter(result => result.outcome === 'created')).toHaveLength(1);
    expect(results.filter(result => result.outcome === 'EEXIST')).toHaveLength(7);
    const bytes = await readFile(target);
    expect(payloads.some(payload => payload.equals(bytes))).toBe(true);
    expect(await readdir(directory)).toEqual(['published.md']);
    expect((await lstat(target)).nlink).toBe(1);
    evidence.push({ case: 'eight_process_race', created: 1, conflicts: 7, final_bytes: bytes.length, final_sha256: sha256(bytes), temporary_residue: 0 });
  });
  it('preserves an existing target byte-for-byte and rejects exclusive creation of the same temporary name', async () => {
    const { directory, target, start } = await fixture();
    const original = Buffer.from('existing unrelated asset'); await writeFile(target, original);
    const existingTemp = path.join(directory, '.engramweave-existing.tmp');
    const handle = await open(existingTemp, 'wx'); await handle.writeFile('owned bytes'); await handle.sync(); await handle.close();
    await expect(open(existingTemp, 'wx')).rejects.toMatchObject({ code: 'EEXIST' });
    const child = start(Buffer.from(manualSource('different bytes')), 'none');
    expect(await child.phase('done')).toMatchObject({ outcome: 'EEXIST' });
    expect(await readFile(target)).toEqual(original);
    expect(await readFile(existingTemp, 'utf8')).toBe('owned bytes');
    evidence.push({ case: 'existing_target_and_exclusive_temp', outcome: 'EEXIST', original_sha256: sha256(original), target_unchanged: true, unrelated_temp_preserved: true });
  });
  it.each(['partial', 'flushed', 'linked', 'cleaned'])('preserves the all-or-absent final file on actual process termination at %s', async phase => {
    const { config, directory, target, start } = await fixture();
    const bytes = Buffer.from(manualSource(`Fault stage ${phase}\n${'payload\n'.repeat(1000)}`));
    const child = start(bytes, phase);
    const message = await child.phase(phase);
    await child.kill();
    const published = ['linked', 'cleaned'].includes(phase);
    if (published) expect(await readFile(target)).toEqual(bytes);
    else await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const temporaryPresent = phase !== 'cleaned';
    if (temporaryPresent) expect((await lstat(message.temporary!)).isFile()).toBe(true);
    else await expect(lstat(message.temporary!)).rejects.toMatchObject({ code: 'ENOENT' });
    if (phase === 'linked') {
      expect((await lstat(target)).nlink).toBe(2);
      // A second process cannot overwrite the published bytes, even with identical input.
      const retry = start(bytes, 'none'); expect(await retry.phase('done')).toMatchObject({ outcome: 'EEXIST' });
      expect(await readFile(target)).toEqual(bytes);
    }
    expect((await enumerateMarkdown(config.vault_path, [])).paths).toEqual(published ? ['20_Sources/published.md'] : []);
    evidence.push({ case: `terminate_${phase}`, final: published ? 'complete' : 'absent', final_sha256: published ? sha256(bytes) : null,
      temporary_residue: temporaryPresent ? 1 : 0, scanner_ignores_residue: true, remaining_names: await readdir(directory) });
  });
});
