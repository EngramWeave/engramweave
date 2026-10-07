import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { compilerFixture, sourceText, waitCompiler } from '../helpers/compiler.js';
import { compilerTemplatePath, loadCompilerTemplate } from '../../packages/core/src/compiler/template.js';
import { readDraft } from '../../packages/core/src/drafts/files.js';

it('preserves submitted Properties and freezes the editable Vault template for a task', async () => {
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let received = '';
  const fixture = await compilerFixture(async (_settings, _prompt, _signal, instructions) => {
    received = instructions; await gate; return { title: 'Candidate', body: 'Only submitted meaning.' };
  }, sourceText.replace('custom: preserve-me', 'captured_at: "2026-10-07T08:00:00+08:00"\ncustom: preserve-me'));
  try {
    const initial = await loadCompilerTemplate(fixture.config.vault_path);
    expect(initial.instructions).toContain('EngramWeave Compiler');
    const template = path.join(fixture.config.vault_path, compilerTemplatePath);
    const custom = 'Respect my terminology. Return only JSON title and body.\n';
    await writeFile(template, custom);
    expect((await loadCompilerTemplate(fixture.config.vault_path)).instructions).toBe(custom);
    const id = randomUUID();
    await fixture.compiler.submit({ path: fixture.sourcePath, revision: fixture.revision, request_id: id });
    await writeFile(template, 'A later user template.\n');
    resume();
    const job = await waitCompiler(fixture.compiler, id);
    expect(job.status).toBe('succeeded');
    expect(received).toBe(custom);
    const draft = await readDraft(fixture.config.vault_path, job.draft_path!);
    expect(draft.metadata.captured_at).toBe('2026-10-07T08:00:00+08:00');
    expect(draft.metadata.annotation).toBe('I understand that memory is reconstructed.');
    const source = await readFile(path.join(fixture.config.vault_path, fixture.sourcePath), 'utf8');
    expect(source).toContain('lifecycle_status: active');
    expect(source).toContain('annotation: "I understand that memory is reconstructed."');
    await writeFile(template, '  ');
    await expect(loadCompilerTemplate(fixture.config.vault_path)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  } finally { resume(); await fixture.close(); }
});
