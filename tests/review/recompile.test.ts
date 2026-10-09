import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture } from '../helpers/analyzer.js';
import { RecompileActions } from '../../packages/core/src/review/recompile.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';

describe('explicit feedback Recompile without inference', () => {
  it.each(['quoted','literal','folded'] as const)('preserves %s Annotation, unrelated bytes and all Draft edits; counts each accepted request once', async mode => {
    let calls = 0; const f = await analyzerFixture(async () => { calls++; return ''; });
    try {
      const annotation = mode === 'quoted' ? '"Old note"' : mode === 'literal' ? '| # user comment\r\n  Old note\r\n  Second line' : '>\r\n  Old note\r\n  Second line';
      const before = `---\r\ntype: raw_source\r\nsource_type: manual\r\nprocessing_status: compiled # stage\r\nlifecycle_status: active\r\nannotation: ${annotation}\r\ncaptured_at: null # preserve\r\ncustom: [one, two]\r\n---\r\nOriginal body.\r\n`;
      await writeFile(path.join(f.config.vault_path,f.sourcePath), before);
      const source = await readMarkdown(f.config.vault_path,f.sourcePath); const draft = await readMarkdown(f.config.vault_path,f.draftPath);
      const actions = new RecompileActions(f.config,f.db,() => false); await actions.initialize();
      const request = { request_id: randomUUID(), source_path: f.sourcePath, source_revision: source.revision, draft_path: f.draftPath, draft_revision: draft.revision, feedback: '中文 feedback:\nNew condition' };
      expect(await actions.submit(request)).toMatchObject({ recompile_count: 1, reused: false }); expect(await actions.submit(request)).toMatchObject({ recompile_count: 1, reused: true });
      const after = await readMarkdown(f.config.vault_path,f.sourcePath); const parsed = parseMarkdown(f.sourcePath,after.bytes);
      expect(parsed.processing_status).toBe('pending'); expect(parsed.annotation).toBe(parseMarkdown(f.sourcePath,source.bytes).annotation + '\n\n' + request.feedback);
      expect(after.bytes.toString()).toContain('captured_at: null # preserve\r\ncustom: [one, two]'); expect(parsed.body_markdown).toBe('Original body.\r\n');
      expect(await readFile(path.join(f.config.vault_path,f.draftPath))).toEqual(draft.bytes); expect(calls).toBe(0); expect(parsed.metadata).not.toHaveProperty('recompile_count');
      f.db.prepare('DELETE FROM recompile_actions').run(); const recovered = new RecompileActions(f.config,f.db,() => false); await recovered.initialize(); expect(recovered.count(f.sourcePath)).toBe(1);
      await expect(recovered.submit({ ...request, feedback: 'different' })).rejects.toMatchObject({ code: 'PATH_CONFLICT' }); await recovered.close(); await actions.close();
    } finally { await f.close(); }
  });
  it('rejects concurrent user edits without consuming feedback', async () => {
    const f = await analyzerFixture();
    try {
      const request = { ...f.request(), feedback: 'feedback' }; const actions = new RecompileActions(f.config,f.db,() => false);
      await writeFile(path.join(f.config.vault_path,f.sourcePath), (await readFile(path.join(f.config.vault_path,f.sourcePath))) + '\nEdit\n');
      await expect(actions.submit(request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' }); expect(actions.count(f.sourcePath)).toBe(0); await actions.close();
    } finally { await f.close(); }
  });
  it('recovers a committed-but-unacknowledged feedback once, preserving conflicts until the approved bytes are restored', async () => {
    const f=await analyzerFixture();
    try {
      const actions=new RecompileActions(f.config,f.db,()=>false);const request={...f.request(),feedback:'Exact feedback'};await actions.submit(request);
      const after=await readMarkdown(f.config.vault_path,f.sourcePath);const filename=path.join(f.config.data_dir,'recompile-actions',`${request.request_id}.json`);const receipt=JSON.parse(await readFile(filename,'utf8'));receipt.completed=false;await writeFile(filename,JSON.stringify(receipt));f.db.prepare('DELETE FROM recompile_actions').run();
      await writeFile(path.join(f.config.vault_path,f.sourcePath),after.bytes+'\nConcurrent user edit\n');const recovered=new RecompileActions(f.config,f.db,()=>false);await recovered.initialize();expect(recovered.busy()).toBe(true);expect(recovered.count(f.sourcePath)).toBe(0);
      await expect(recovered.submit(request)).rejects.toMatchObject({code:'SOURCE_CHANGED'});expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes.toString()).toContain('Concurrent user edit');
      await writeFile(path.join(f.config.vault_path,f.sourcePath),after.bytes);expect(await recovered.submit(request)).toMatchObject({reused:true,recompile_count:1});expect((await readMarkdown(f.config.vault_path,f.sourcePath)).bytes).toEqual(after.bytes);expect(recovered.busy()).toBe(false);await recovered.close();await actions.close();
    }finally{await f.close();}
  });
});
