import { describe, expect, it } from 'vitest';
import { analyzerFixture } from '../helpers/analyzer.js';
import { freezeAnalysis } from '../../packages/core/src/analysis/input.js';
import { AnalysisMaterials } from '../../packages/core/src/analysis/materials.js';
import { analysisModelOutput } from '../../packages/core/src/analysis/output.js';
import { AnalysisTools } from '../../packages/core/src/analysis/tools.js';

describe('short Analyzer evidence IDs', () => {
  it('delivers each input once, expands exact supplied segments and rejects unknown or legacy model citations', async () => {
    const f = await analyzerFixture();
    try {
      const snapshot = await freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings);
      const materials = new AnalysisMaterials(snapshot); const evidence = { items: [f.hit], coverage: null, diagnostics: [] };
      const input = materials.readInput(evidence);
      for (const name of ['source','draft'] as const) {
        expect(input[name].segments.map(segment => segment.text).join('\n')).toBe(snapshot.input[name].numbered_lines.map(line => line.replace(/^\d+: /,'')).join('\n'));
        expect(input[name]).not.toHaveProperty('body'); expect(input[name]).not.toHaveProperty('numbered_lines');
      }
      expect(JSON.stringify(input)).not.toContain(snapshot.input.source.revision);
      const wire = { summary: 'A condition is lost.', findings: [{ message: 'Keep condition A.', evidence: ['S1','D1','K1','K1'] }] };
      const result = analysisModelOutput(JSON.stringify(wire), 'review', snapshot, evidence, materials);
      expect(result).toMatchObject({ findings: [{ message: 'Keep condition A.', evidence: [materials.resolve('S1'),materials.resolve('D1'), { path: f.libraryPath, revision: f.hit.revision, start_line: 4, end_line: 4 }] }], limitations: [] });
      for (const id of ['K99','S0',f.libraryPath]) expect(() => analysisModelOutput(JSON.stringify({ ...wire, findings: [{ message: 'Bad citation', evidence: [id] }] }), 'review', snapshot, evidence, materials)).toThrow();
      expect(() => analysisModelOutput(JSON.stringify({ ...wire, findings: [{ message: 'Bad citation', evidence: [materials.resolve('K1')] }] }), 'review', snapshot, evidence, materials)).toThrow();
    } finally { await f.close(); }
  });
  it('keeps tool-delivered IDs stable when recall reorders or adds evidence, without granting unread files', async () => {
    const f = await analyzerFixture();
    try {
      const snapshot = await freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings);
      const evidence = { items: [f.hit], coverage: null, diagnostics: [] };
      const tools = new AnalysisTools(snapshot,'review',f.recall,evidence,new AbortController().signal);
      const input = tools.materials.readInput(evidence); expect(input.library.items[0]?.id).toBe('K1');
      const original = await f.recall.recall({ q: 'initial' });
      const next = { ...f.hit, chunk_id: 'another-chunk', start_line: 5, end_line: 5, text: 'Another supplied condition.' };
      f.recall.recall = async () => ({ ...original, items: [next,f.hit] });
      const result = await tools.call('recall',{ q: 'condition' }) as { items: { id: string }[] };
      expect(result.items.map(item => item.id)).toEqual(['K2','K1']);
      expect(tools.materials.resolve('K1').start_line).toBe(4); expect(tools.materials.resolve('K2').start_line).toBe(5);
      expect(() => new AnalysisMaterials(snapshot).resolve('K1')).toThrow();
      await expect(tools.call('read_evidence',{chunk_id:'unread'})).rejects.toMatchObject({code:'PATH_OUTSIDE_SCOPE'});
    } finally { await f.close(); }
  });
});
