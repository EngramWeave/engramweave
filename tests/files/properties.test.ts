import { afterEach, expect, it, vi } from 'vitest';
import { chmod, link, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PropertyNative } from '../../packages/core/src/files/property-native.js';
import { recoverPropertyJournal, writeSourceProperties } from '../../packages/core/src/files/properties.js';
import { pendingSourceBytes } from '../../packages/core/src/source/properties.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { CoreError } from '../../packages/core/src/errors.js';
import { isolatedRuntime } from '../helpers/runtime.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const runtime = await isolatedRuntime(); cleanups.push(runtime.cleanup);
  const native = new PropertyNative(); cleanups.push(() => native.close());
  const relative = "20_Sources/中文 ' $().md";
  await writeDocument(runtime.config.vault_path, relative, manualSource('Original body', 'annotation: Saved note\n'));
  return { ...runtime, native, relative, vault: runtime.config.vault_path };
}
it('commits through real Windows locked handles and leaves no artifacts', async () => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  const updated = pendingSourceBytes(relative, before.bytes);
  const committed = await writeSourceProperties(vault, relative, before, updated, native);
  const current = await readMarkdown(vault, relative);
  expect(committed.bytes).toEqual(current.bytes);
  expect(committed.revision).toBe(current.revision);
  expect(committed.size).toBe(current.size);
  expect(committed.mtime).toBeCloseTo(current.mtime, 2);
  expect(await readdir(path.join(vault, '20_Sources'))).toEqual([path.basename(relative)]);
  expect(await readFile(path.join(vault, relative))).toEqual(updated);
});
it('refuses a changed revision without overwriting user edits', async () => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  const edited = Buffer.concat([before.bytes, Buffer.from('\nUser edit')]);
  await writeFile(path.join(vault, relative), edited);
  await expect(writeSourceProperties(vault, relative, before, pendingSourceBytes(relative, before.bytes), native)).rejects.toMatchObject({ code: 'PROPERTY_WRITE_CONFLICT' });
  expect(await readFile(path.join(vault, relative))).toEqual(edited);
});
it('rejects a hard-linked Source without mutating either name', async () => {
  const { vault, relative, native, root } = await fixture();
  const before = await readMarkdown(vault, relative);
  const other = path.join(root, 'alias.md');
  await link(path.join(vault, relative), other);
  await expect(writeSourceProperties(vault, relative, before, pendingSourceBytes(relative, before.bytes), native)).rejects.toMatchObject({ code: 'PROPERTY_WRITE_CONFLICT' });
  expect(await readFile(other)).toEqual(before.bytes);
});
it('preserves a known Capture temporary hard-link while normalizing only the Record name', async () => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  const residue = path.join(vault, '20_Sources', `.engramweave-capture-${randomUUID()}.tmp`);
  await link(path.join(vault, relative), residue);
  const updated = pendingSourceBytes(relative, before.bytes);
  await writeSourceProperties(vault, relative, before, updated, native);
  expect(await readFile(path.join(vault, relative))).toEqual(updated);
  expect(await readFile(residue)).toEqual(before.bytes);
});
it('refuses a real external file lock without creating artifacts or changing original bytes', async () => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  const script = "$r = [Console]::ReadLine() | ConvertFrom-Json; $h = [IO.File]::Open($r.path, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null } finally { $h.Dispose() }";
  const child = spawn(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanups.push(async () => { if (child.exitCode === null) { const done = once(child, 'close'); child.stdin.end('\n'); await done; } });
  child.stderr.resume();
  const locked = once(child.stdout, 'data');
  child.stdin.write(JSON.stringify({ path: path.join(vault, relative) }) + '\n');
  expect(String((await locked)[0]).trim()).toBe('locked');
  await expect(writeSourceProperties(vault, relative, before, pendingSourceBytes(relative, before.bytes), native)).rejects.toMatchObject({ code: 'PROPERTY_WRITE_CONFLICT' });
  const done = once(child, 'close'); child.stdin.end('\n'); await done;
  expect(await readFile(path.join(vault, relative))).toEqual(before.bytes);
  expect(await readdir(path.join(vault, '20_Sources'))).toEqual([path.basename(relative)]);
});
it('refuses a parent switched to a junction before native creation without writing outside the Vault', async () => {
  const { vault, relative, native, root } = await fixture();
  const before = await readMarkdown(vault, relative);
  const original = native.run.bind(native);
  const moved = path.join(root, 'moved'); const outside = path.join(root, 'outside');
  await mkdir(outside);
  let swapped = false;
  vi.spyOn(native, 'run').mockImplementation(async (...args) => {
    if (!args[6] && !swapped) {
      swapped = true;
      await rename(path.join(vault, '20_Sources'), moved);
      await symlink(outside, path.join(vault, '20_Sources'), 'junction');
    }
    return original(...args);
  });
  await expect(writeSourceProperties(vault, relative, before, pendingSourceBytes(relative, before.bytes), native)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
  expect(await readdir(outside)).toEqual([]);
  expect(await readFile(path.join(moved, path.basename(relative)))).toEqual(before.bytes);
});
it('protects absolute ancestors above the Vault against a junction swap with identical external bytes', async () => {
  const { vault, relative, native, root } = await fixture();
  const before = await readMarkdown(vault, relative);
  const container = path.join(root, 'container'); await mkdir(container);
  const containedVault = path.join(container, 'vault'); await rename(vault, containedVault);
  const outside = path.join(root, 'outside-container'); const moved = path.join(root, 'moved-container');
  await mkdir(path.join(outside, 'vault', '20_Sources'), { recursive: true });
  const external = path.join(outside, 'vault', relative); await writeFile(external, before.bytes);
  const original = native.run.bind(native); let swapped = false;
  vi.spyOn(native, 'run').mockImplementation(async (...args) => {
    if (!args[6] && !swapped) {
      swapped = true; await rename(container, moved); await symlink(outside, container, 'junction');
    }
    return original(...args);
  });
  await expect(writeSourceProperties(containedVault, relative, before, pendingSourceBytes(relative, before.bytes), native)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
  expect(await readFile(external)).toEqual(before.bytes);
  expect(await readdir(path.dirname(external))).toEqual([path.basename(relative)]);
  expect(await readFile(path.join(moved, 'vault', relative))).toEqual(before.bytes);
});
it('charges immediate failure recovery reads and propagates a byte-budget failure', async () => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  vi.spyOn(native, 'run').mockImplementationOnce(async (...args) => {
    // Simulate failure after the real durable journal creation, before any file move.
    await writeFile(path.join(vault, '20_Sources', args[2] + '.json'), Buffer.from(args[7]!.manifest_bytes, 'base64'));
    throw new Error('Injected commit failure');
  });
  let charged = 0;
  const budget = (count: number) => { charged += count; throw new CoreError('IO_ERROR', 'Scan exceeds the cumulative read byte limit'); };
  await expect(writeSourceProperties(vault, relative, before, pendingSourceBytes(relative, before.bytes), native, budget)).rejects.toMatchObject({ code: 'IO_ERROR' });
  expect(charged).toBeGreaterThan(0);
  expect(await readFile(path.join(vault, relative))).toEqual(before.bytes);
  expect((await readdir(path.join(vault, '20_Sources'))).some(name => name.endsWith('.json'))).toBe(true);
});
it.each(['replace', 'in_place'])('retains an uncertain journal changed by %s after observation', async change => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  const updated = pendingSourceBytes(relative, before.bytes);
  const stem = `.engramweave-properties-${randomUUID()}`;
  const directory = path.join(vault, '20_Sources'); const journal = path.join(directory, stem + '.json');
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.stringify({ version: 1, relative, before: hash(before.bytes), after: hash(updated) });
  await writeFile(journal, manifest); await writeFile(path.join(directory, stem + '.tmp'), updated);
  const original = native.run.bind(native);
  const uncertain = manifest + ' ';
  vi.spyOn(native, 'run').mockImplementation(async (...args) => {
    if (change === 'replace') {
      await rename(journal, path.join(directory, 'observed-manifest.txt'));
      await writeFile(journal, uncertain);
    } else await writeFile(journal, uncertain);
    return original(...args);
  });
  await expect(recoverPropertyJournal(vault, '20_Sources', stem + '.json', native)).rejects.toMatchObject({ code: 'PROPERTY_WRITE_CONFLICT' });
  expect(await readFile(journal, 'utf8')).toBe(uncertain);
  expect(await readFile(path.join(vault, relative))).toEqual(before.bytes);
  expect(await readFile(path.join(directory, stem + '.tmp'))).toEqual(updated);
});
it('does not bypass a read-only Source', async () => {
  const { vault, relative, native } = await fixture();
  const before = await readMarkdown(vault, relative);
  const target = path.join(vault, relative);
  await chmod(target, 0o444);
  try {
    await expect(writeSourceProperties(vault, relative, before, pendingSourceBytes(relative, before.bytes), native)).rejects.toMatchObject({ code: 'PROPERTY_WRITE_CONFLICT' });
    expect(await readFile(target)).toEqual(before.bytes);
  } finally { await chmod(target, 0o666); }
});
it.each(['before_move', 'after_move', 'after_publish', 'conflict'])('recovers interrupted publication %s without relying on SQLite', async state => {
  const { vault, relative, native } = await fixture();
  const original = (await readMarkdown(vault, relative)).bytes;
  const updated = pendingSourceBytes(relative, original);
  const stem = `.engramweave-properties-${randomUUID()}`;
  const directory = path.join(vault, '20_Sources');
  const target = path.join(vault, relative);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const journal = { version: 1, relative, before: hash(original), after: hash(updated) };
  await writeFile(path.join(directory, stem + '.json'), JSON.stringify(journal));
  await writeFile(path.join(directory, stem + '.tmp'), updated);
  if (state !== 'before_move') {
    const { rename } = await import('node:fs/promises');
    await rename(target, path.join(directory, stem + '.bak'));
  }
  if (state === 'after_publish') {
    const { rename } = await import('node:fs/promises');
    await rename(path.join(directory, stem + '.tmp'), target);
  }
  if (state === 'conflict') await writeFile(target, 'Concurrent user replacement');
  if (state === 'conflict') {
    await expect(recoverPropertyJournal(vault, '20_Sources', stem + '.json', native)).rejects.toMatchObject({ code: 'PROPERTY_WRITE_CONFLICT' });
    expect(await readFile(target, 'utf8')).toBe('Concurrent user replacement');
    expect(await readFile(path.join(directory, stem + '.bak'))).toEqual(original);
  } else {
    await recoverPropertyJournal(vault, '20_Sources', stem + '.json', native);
    expect(await readdir(directory)).toEqual([path.basename(relative)]);
    expect(await readFile(target)).toEqual(state === 'after_publish' ? updated : original);
  }
});
