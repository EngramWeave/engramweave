import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { compilerFixture, sourceText, waitCompiler } from '../helpers/compiler.js';
import { createCapture } from '../../packages/core/src/capture/create.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';

it('replays a lost Capture receipt after Compiler stage advancement while preserving stage and rejecting user changes', async () => {
  const original = sourceText.replace('source_type: paper', 'source_type: manual').replace('processing_status: pending # stage\n', '');
  const fixture = await compilerFixture(async () => ({ title: 'Captured meaning', body: 'A retained candidate.' }), original);
  try {
    const id = randomUUID();
    await fixture.compiler.submit({ path: fixture.sourcePath, revision: fixture.revision, request_id: id });
    expect((await waitCompiler(fixture.compiler, id)).status).toBe('succeeded');
    const current = await readMarkdown(fixture.config.vault_path, fixture.sourcePath);
    fixture.db.prepare('DELETE FROM compiler_jobs').run();
    expect(await createCapture(fixture.config.vault_path, { path: fixture.sourcePath, markdown: original })).toMatchObject({ created: false, revision: current.revision });
    expect(await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8')).toBe(current.bytes.toString('utf8'));
    const edited = current.bytes.toString('utf8') + '\nA later user edit.\n';
    await writeFile(path.join(fixture.config.vault_path, fixture.sourcePath), edited);
    await expect(createCapture(fixture.config.vault_path, { path: fixture.sourcePath, markdown: original })).rejects.toMatchObject({ code: 'PATH_CONFLICT' });
    expect(await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8')).toBe(edited);
  } finally { await fixture.close(); }
}, 60_000);
