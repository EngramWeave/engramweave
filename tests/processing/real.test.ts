import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { ProcessingRound } from '@engramweave/contracts';
import { httpRuntime } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { defaultRecallSettings } from '../../packages/core/src/recall/settings.js';
import { analysisProfile } from '../helpers/analyzer.js';
import { startCore } from '../../packages/core/dist/main.js';

it.skipIf(process.env.ENGRAMWEAVE_D_LIVE !== '1')('runs complete API and Codex rounds and a real interval trigger with explicit semantic setup', async () => {
  const f = await httpRuntime(async vault => {
    for (const root of ['20_Sources','30_Drafts','40_Knowledge','10_Ideas','50_Research']) await mkdir(path.join(vault,root),{recursive:true});
    await writeDocument(vault,'40_Knowledge/version.md','---\ntitle: 内容版本保护\n---\n写入前核对文件内容哈希；并发修改需要报告冲突，不能覆盖用户编辑。索引是可重建的投影，增量更新只处理变化的文件。\n');
  },startCore);
  const directory = path.resolve('.local/p2-d/real',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory,{recursive:true});
  const api = async (route: string,body?: unknown) => {const response = await f.request(route,body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value = await response.json();if (!response.ok) throw new Error(JSON.stringify(value));return value;};
  const wait = async (id: string) => {for (let n=0;n<1800;n++) {const r:ProcessingRound = await api(`/v1/processing-round?id=${id}`);if (!['queued','running'].includes(r.status)) return r;await delay(500);}throw new Error('Real round timed out');};
  try {
    const scan = await api('/v1/scans',{mode:'refresh'});while (['queued','running'].includes((await api(`/v1/jobs/${scan.job.id}`)).status)) await delay(50);
    const models = await (await fetch('http://127.0.0.1:8095/v1/models')).json();await api('/v1/recall/settings',{settings:{...defaultRecallSettings,model:models.data[0].id}});await api('/v1/recall/index',{mode:'build'});while ((await api('/v1/recall/status')).state === 'running') await delay(100);
    expect((await api('/v1/recall/status')).initialized).toBe(true);await api('/v1/analysis/templates');
    const routes = process.env.ENGRAMWEAVE_D_ROUTES === 'api' ? ['api'] as const : process.env.ENGRAMWEAVE_D_ROUTES === 'codex' ? ['codex'] as const : ['api','codex'] as const; const outcomes = [];
    for (const route of routes) {
      const execution = {...defaultSettings,route,endpoint:'http://127.0.0.1:8094/v1',model:route === 'api' ? 'qwen3.8-27b' : 'gpt-6.1-sol',codex_path:process.env.ENGRAMWEAVE_D_CODEX_PATH ?? '',output_format:'text' as const,reasoning_effort:route === 'api' ? 'none' as const : 'low' as const,timeout_seconds:600};
      await api('/v1/compiler/settings',{settings:execution});const profile = analysisProfile('output');profile.review.execution = execution;profile.relation.execution = execution;await api('/v1/analysis/settings',{settings:{default_profile:'knowledge',profiles:[profile]}});
      await writeDocument(f.config.vault_path,`20_Sources/${route}.md`,manualSource('索引是文件的可重建投影。刷新只更新新增或变化的内容；写入前仍要检查当前内容哈希，并发修改时报告冲突。','annotation: "我的理解：投影数据库不能取代用户文件。"\n'));
      const id = randomUUID();const started = performance.now();await api('/v1/processing-rounds',{request_id:id,mode:'pending'});const round = await wait(id);
      const item = round.items.find(i => i.source_path === `20_Sources/${route}.md`)!;const result = item.analyzer_job_id ? await api(`/v1/analysis/result?id=${item.analyzer_job_id}`) : null;
      await writeFile(path.join(directory,`${route}.json`),JSON.stringify({round,result},null,2));expect(round.status,JSON.stringify(round)).toBe('succeeded');expect(item.draft_path).toBeTruthy();expect(result?.review).not.toBeNull();expect(result?.relation).not.toBeNull();expect(result?.stale).toBe(false);
      if (route === 'codex') for (const task of ['review','relation']) expect(result.record[task].observations.some((o:{tool:string}) => o.tool === 'read_input')).toBe(true);
      outcomes.push({route,elapsed_ms:performance.now()-started,round_id:id,draft:item.draft_path});await writeFile(path.join(directory,'outcomes.json'),JSON.stringify(outcomes,null,2));
    }
    if (process.env.ENGRAMWEAVE_D_SCHEDULE === '1') {
      const execution = {...defaultSettings,route:'api',endpoint:'http://127.0.0.1:8094/v1',model:'qwen3.8-27b',output_format:'text',reasoning_effort:'none'};
      await api('/v1/compiler/settings',{settings:execution});const profile = analysisProfile('none');profile.review.execution = execution as typeof profile.review.execution;profile.relation.execution = execution as typeof profile.relation.execution;await api('/v1/analysis/settings',{settings:{default_profile:'knowledge',profiles:[profile]}});
      await writeDocument(f.config.vault_path,'20_Sources/scheduled.md',manualSource('仅处理变化的文件，写入前检查版本。'));
      const s = await api('/v1/processing/settings');await api('/v1/processing/settings',{...s,enabled:true,mode:'interval',interval_minutes:1});let round:ProcessingRound|undefined;
      for (let n=0;n<300;n++) {const state = await api('/v1/processing/state');if (state.latest?.trigger === 'schedule') {round = await wait(state.latest.id);break;}await delay(500);}
      expect(round?.status,JSON.stringify(round)).toBe('succeeded');await api('/v1/processing/settings',{...s,enabled:false});await writeFile(path.join(directory,'scheduled.json'),JSON.stringify(round,null,2));
    }
  } finally {for (const name of await readdir(f.config.data_dir)) if (/^(compiler|analyzer)-codex-/.test(name)) await cp(path.join(f.config.data_dir,name),path.join(directory,name),{recursive:true});await f.cleanup();}
},1_800_000);
