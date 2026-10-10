import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { humanFixture } from '../helpers/human-review.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';

it('creates one exact user Idea with Source and Draft backlinks, without changing their bytes or invoking models', async () => {
  const f = await humanFixture();
  try {
    const before = await readFile(path.join(f.config.vault_path,f.sourcePath)); const draft = await readFile(path.join(f.config.vault_path,f.draftPath));
    const input = '  用户的想法\r\n\r\n保留格式 **idea**\n'; const req = await f.request('idea',input);
    const result = await f.human.submit(req); const idea = parseMarkdown(result.idea_path!, await readFile(path.join(f.config.vault_path,result.idea_path!)));
    expect(idea.kind).toBe('idea'); expect(idea.body_markdown).toBe(input); expect(idea.metadata.sources).toEqual([`[[${f.sourcePath}]]`]); expect(idea.metadata.drafts).toEqual([`[[${f.draftPath}]]`]);
    expect(await readFile(path.join(f.config.vault_path,f.sourcePath))).toEqual(before); expect(await readFile(path.join(f.config.vault_path,f.draftPath))).toEqual(draft);
    expect((await f.human.submit(req)).reused).toBe(true); expect(await readdir(path.join(f.config.vault_path,'10_Ideas'))).toHaveLength(1); expect(f.analyzer.all()).toHaveLength(1);
    await writeFile(path.join(f.config.vault_path,result.idea_path!), 'My later edit');
    const restarted=f.create();await restarted.initialize(); expect((await restarted.submit(req)).reused).toBe(true);
    expect(await readFile(path.join(f.config.vault_path,result.idea_path!),'utf8')).toBe('My later edit');
    await expect(restarted.submit({...req,note:'Different'})).rejects.toMatchObject({code:'PATH_CONFLICT'});
  } finally { await f.close(); }
});
it('refuses empty input and existing targets without changing the Source',async()=>{
  const f=await humanFixture();try{
    await expect(f.human.submit(await f.request('idea',' \n '))).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const req=await f.request('idea','Idea'); const filename=path.join(f.config.vault_path,`10_Ideas/${req.request_id}.md`);
    const {mkdir}=await import('node:fs/promises');await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,'Existing note');
    await expect(f.human.submit(req)).rejects.toMatchObject({code:'PATH_CONFLICT'});expect(await readFile(filename,'utf8')).toBe('Existing note');expect(f.human.busy()).toBe(false);expect((await f.human.receipt(req.request_id)).status).toBe('not_found');
  }finally{await f.close();}
});
