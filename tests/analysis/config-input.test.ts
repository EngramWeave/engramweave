import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzerFixture, analysisProfile, emptyAnalysis } from '../helpers/analyzer.js';
import { analysisTemplates, saveAnalysisTemplate, loadAnalysisTemplate, parseTemplate } from '../../packages/core/src/analysis/templates.js';
import { freezeAnalysis } from '../../packages/core/src/analysis/input.js';
import { writeAnalysisSelection } from '../../packages/core/src/analysis/selection.js';
import { createCapture } from '../../packages/core/src/capture/create.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';

describe('Analyzer configuration and explicit input', () => {
  it('seeds once, preserves edited templates, repairs malformed content and rejects stale template writes', async () => {
    let calls = 0; const f = await analyzerFixture(async task => { calls++; return emptyAnalysis(task); });
    try {
      const first = (await analysisTemplates(f.config.vault_path)).items[0]!;
      const changed = { ...first, content: first.content + '\nCustom user instruction.\n' };
      const saved = await saveAnalysisTemplate(f.config.vault_path, changed);
      expect((await analysisTemplates(f.config.vault_path)).items.find(t => t.path === first.path)?.content).toBe(changed.content);
      await expect(saveAnalysisTemplate(f.config.vault_path, first)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      await writeFile(path.join(f.config.vault_path, first.path), 'Broken template');
      const broken = (await analysisTemplates(f.config.vault_path)).items.find(t => t.path === first.path)!;
      await saveAnalysisTemplate(f.config.vault_path, { ...broken, content: saved.content });
      expect((await loadAnalysisTemplate(f.config.vault_path, first.path)).content).toBe(saved.content);
      expect(calls).toBe(0);
      expect(() => parseTemplate('---\ncontext: {scope: pdf, limit: 10, required: true}\n---\nRead')).toThrow();
      await expect(loadAnalysisTemplate(f.config.vault_path, '90_System/Other.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
    } finally { await f.close(); }
  });
  it('keeps Source preset as a reference, allows only pending selection and leaves other bytes untouched', async () => {
    const f = await analyzerFixture();
    try {
      const relative = '20_Sources/pending.md'; const original = manualSource('Keep the body byte-for-byte.', 'processing_status: pending # stage\nannotation: "Keep understanding"\n');
      await writeDocument(f.config.vault_path, relative, original);
      const file = await readMarkdown(f.config.vault_path, relative);
      const saved = await writeAnalysisSelection(f.config.vault_path, { path: relative, revision: file.revision, profile_id: 'knowledge' });
      const text = await readFile(path.join(f.config.vault_path, relative), 'utf8');
      expect(text.replace('analysis_profile: "knowledge"\n', '')).toBe(original);
      await expect(writeAnalysisSelection(f.config.vault_path, { path: relative, revision: file.revision, profile_id: 'knowledge' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      expect(saved.revision).not.toBe(file.revision);
      await expect(writeAnalysisSelection(f.config.vault_path, { path: f.sourcePath, revision: f.request().source_revision, profile_id: 'knowledge' })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
      const capture = { path: '20_Sources/captured.md', markdown: manualSource('Captured text'), analysis_profile: 'knowledge' };
      const created = await createCapture(f.config.vault_path, capture); expect(created.created).toBe(true);
      expect((await createCapture(f.config.vault_path, capture)).created).toBe(false);
      expect(await readFile(path.join(f.config.vault_path, capture.path), 'utf8')).toContain('analysis_profile: "knowledge"');
    } finally { await f.close(); }
  });
  it('freezes final current config with a specific Draft and rejects missing Profile or version/association mismatch', async () => {
    const f = await analyzerFixture();
    try {
      const snapshot = await freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings);
      expect(snapshot.input.source.annotation).toContain('broader'); expect(snapshot.input.draft.body).toContain('always');
      const updated = analysisProfile('output'); updated.review.execution.model = 'new-current-model';
      await f.analyzer.settings.save({ default_profile: 'knowledge', profiles: [updated] });
      expect((await freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings)).profile.review.execution.model).toBe('new-current-model');
      expect(snapshot.profile.review.execution.model).toBe('fixture');
      await expect(freezeAnalysis(f.config.vault_path, { ...f.request(), draft_revision: '0'.repeat(64) }, f.analyzer.settings)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      await expect(freezeAnalysis(f.config.vault_path, { ...f.request(), profile_id: 'deleted' }, f.analyzer.settings)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
      await expect(f.analyzer.settings.save({ default_profile: null, profiles: [updated, updated] })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
      await f.analyzer.settings.save({ default_profile: null, profiles: [] });
      await expect(freezeAnalysis(f.config.vault_path, f.request(), f.analyzer.settings)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    } finally { await f.close(); }
  });
});
