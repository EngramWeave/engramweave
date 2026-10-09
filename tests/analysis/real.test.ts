import { readFile, mkdir, writeFile, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture, analysisProfile } from '../helpers/analyzer.js';
import { writeDocument, manualSource, sha256 } from '../helpers/fixtures.js';
import { readMarkdown } from '../../packages/core/dist/files/read.js';
import { AnalyzerJobs } from '../../packages/core/dist/jobs/analyzer.js';
import { SemanticRecall } from '../../packages/core/dist/recall/index.js';
import { defaultRecallSettings } from '../../packages/core/dist/recall/settings.js';
import { ScanJobs } from '../../packages/core/dist/jobs/scans.js';

const enabled = process.env.ENGRAMWEAVE_C2_LIVE === '1';
describe('C2 opt-in real models and limited Codex MCP', () => {
  it.skipIf(!enabled)('validates both Analyzers through API and Codex with real semantic context on knowledge and academic materials', async () => {
    const f = await analyzerFixture(); let recall: SemanticRecall | undefined; let analyzer: AnalyzerJobs | undefined;
    const evidenceDirectory = path.resolve('.local/p2-c2/real', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(evidenceDirectory, { recursive: true });
    const routes = process.env.ENGRAMWEAVE_C2_ROUTES === 'api' ? ['api'] as const : process.env.ENGRAMWEAVE_C2_ROUTES === 'codex' ? ['codex'] as const : ['api','codex'] as const;
    try {
      await writeDocument(f.config.vault_path, '40_Knowledge/visibility.md', '---\ntitle: 可见性和原子性\n---\nvolatile 保证发布和可见性，但不让 counter++ 的读取、加一和写回成为一个不可分割操作。复合操作需要锁或原子更新。\n');
      await writeDocument(f.config.vault_path, '10_Ideas/reading.md', '---\ntitle: 理解核对\n---\n阅读后用自己的话复述，再逐条核对原文的限定条件，不因措辞相似就推定等价。\n');
      await writeDocument(f.config.vault_path, '50_Research/scope.md', '---\ntitle: 外推和指标测量\n---\n模拟研究记录：只测自评满意度且仅招募健康青年，不能直接推断工作表现改善，也不能外推老年慢性病人长期使用的效果。\n');
      const scan = new ScanJobs(f.db, f.config.vault_path, () => false); scan.submit('refresh'); await scan.close();
      recall = new SemanticRecall(f.config, f.db);
      const models = await (await fetch('http://127.0.0.1:8095/v1/models')).json() as { data: { id: string }[] };
      await recall.settings.save({ ...defaultRecallSettings, model: models.data[0]!.id }); await recall.submit('build');
      const deadline = Date.now() + 120_000;
      while ((await recall.status()).state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect((await recall.status()).state).toBe('idle');
      analyzer = new AnalyzerJobs(f.db, f.config, recall, () => false); await analyzer.initialize();
      const cases = [
        { name: 'knowledge', body: 'Java 的 volatile 为变量访问提供可见性和发布关系。counter++ 由读取、修改和写回组成，仍然需要锁或原子操作。仅讨论这里投递的段落。', annotation: '我理解只要 counter 标记 volatile，counter++ 就能保持并发计数准确。', draft: 'volatile 解决了 counter++ 并发累加的准确性，无需锁。' },
        { name: 'academic', body: '模拟论文选段：研究招募 30 名健康青年，随访两周。干预后自评满意度提高，未测量实际工作表现。结果不能证明长期疗效或适用于其他年龄人群。', annotation: '是否可以说工作效率改善，并推荐老年人长期使用？请核对测量指标和样本范围。', draft: '研究证明干预能提高所有年龄人群的实际工作效率，适合长期使用。' },
      ];
      await writeDocument(f.config.vault_path, '50_Research/position.md', '# Position representation\n\n验证用研究笔记：没有递归和卷积的模型需要额外的位置表示来使用序列顺序；不能把使用 Attention 推断为不需要位置信息。这是测试材料，不是认可的新研究结论。');
      const paperScan = new ScanJobs(f.db, f.config.vault_path, () => false); paperScan.submit('refresh'); await paperScan.close(); await recall.submit('update');
      while ((await recall.status()).state === 'running') await new Promise(resolve => setTimeout(resolve, 50));
      cases.push({ name: 'paper', body: 'Attention Is All You Need §3.5 有限投递选段（https://arxiv.org/html/1706.03762v7#S3.SS5）：\n“we must inject some information about the relative or absolute position of the tokens in the sequence.”\n本节语境摘述：该模型不使用递归或卷积，作者为使用序列顺序而加入位置表示。本次没有投递全文或实验结果。', annotation: '测试用理解与批注：我理解只用 Attention 就能自然识别序列顺序，所以位置编码只是可选装饰。请检查这份理解。', draft: 'Transformer 只使用 Attention，因而自然知道 token 顺序，不需要额外位置表示。' });
      const outcomes = [];
      const selectedCases = cases.filter(c => !process.env.ENGRAMWEAVE_C2_MATERIAL || c.name === process.env.ENGRAMWEAVE_C2_MATERIAL);
      expect(selectedCases.length).toBeGreaterThan(0);
      for (const material of selectedCases) for (const route of routes) {
        await writeDocument(f.config.vault_path, f.sourcePath, manualSource(material.body, `processing_status: compiled\nannotation: ${JSON.stringify(material.annotation)}\n`));
        await writeDocument(f.config.vault_path, f.draftPath, `---\ntype: draft\ntitle: ${material.name}\nlifecycle_status: active\nsources: ["[[${f.sourcePath}]]"]\n---\n${material.draft}\n`);
        const profile = analysisProfile('output');
        for (const task of ['review','relation'] as const) {
          profile[task].template_path = `90_System/Prompts/${task === 'review' ? 'Review' : 'Relation'}/${material.name === 'knowledge' ? 'Knowledge' : 'Academic'}.md`;
          profile[task].execution = { ...profile[task].execution, route, model: route === 'api' ? 'qwen3.8-27b' : 'gpt-6.1-sol', codex_path: process.env.ENGRAMWEAVE_C2_CODEX_PATH ?? '', output_format: 'text', reasoning_effort: route === 'api' ? 'none' : 'low', timeout_seconds: 600 };
          if (route === 'api' && process.env.ENGRAMWEAVE_C2_MAX_TOKENS) profile[task].execution.output_tokens = { parameter: 'max_tokens', limit: Number(process.env.ENGRAMWEAVE_C2_MAX_TOKENS) };
          if (route === 'api' && process.env.ENGRAMWEAVE_C2_FORMAT === 'json_schema') profile[task].execution.output_format = 'json_schema';
        }
        await analyzer.settings.save({ default_profile: profile.id, profiles: [profile] });
        const before = await Promise.all([f.sourcePath, f.draftPath, '40_Knowledge/visibility.md','10_Ideas/reading.md','50_Research/scope.md'].map(p => readFile(path.join(f.config.vault_path, p))));
        const source = await readMarkdown(f.config.vault_path, f.sourcePath); const draft = await readMarkdown(f.config.vault_path, f.draftPath);
        const request = { ...f.request(), source_revision: source.revision, draft_revision: draft.revision };
        const started = performance.now(); await analyzer.submit(request); await analyzer.wait();
        const result = await analyzer.result(request.request_id);
        await writeFile(path.join(evidenceDirectory, `${material.name}-${route}.json`), JSON.stringify(result, null, 2));
        outcomes.push({ material: material.name, route, elapsed_ms: performance.now() - started, job: result.job, findings: result.review?.findings.length, suggestions: result.relation?.suggestions.length });
        await writeFile(path.join(evidenceDirectory, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
        expect(result.job.status, JSON.stringify(result.job)).toBe('succeeded'); expect(result.review?.findings.length).toBeGreaterThan(0);
        expect(result.stale).toBe(false);
        if (route === 'codex') for (const task of ['review','relation'] as const) expect((result.record[task] as { observations: { tool: string }[] }).observations.some(o => o.tool === 'read_input')).toBe(true);
        const after = await Promise.all([f.sourcePath, f.draftPath, '40_Knowledge/visibility.md','10_Ideas/reading.md','50_Research/scope.md'].map(p => readFile(path.join(f.config.vault_path, p))));
        expect(after.map(sha256)).toEqual(before.map(sha256));
      }
    } finally {
      for (const name of await readdir(f.config.data_dir)) if (name.startsWith('analyzer-codex-')) await cp(path.join(f.config.data_dir, name), path.join(evidenceDirectory, name), { recursive: true });
      await analyzer?.close(); await recall?.close(); await f.close();
    }
  }, 2_800_000);
});
