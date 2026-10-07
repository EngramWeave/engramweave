import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { archivedSample, manualSource, realBytes, realSamples, sha256 } from '../helpers/fixtures.js';

describe('Source processing and lifecycle properties', () => {
  it.each([
    ['', undefined, null],
    ['processing_status: null\n', null, null],
    ['processing_status:\n', null, null],
    ['processing_status: ""\n', '', null],
    ['processing_status: archived\n', 'archived', 'archived'],
  ])('normalizes %j without adding or changing raw metadata', (line, rawValue, normalized) => {
    const result = parseMarkdown('20_Sources/status.md', Buffer.from(manualSource('body', line)));
    expect(result).toMatchObject({ state: 'ready', processing_status: normalized });
    if (rawValue === undefined) expect(result.metadata).not.toHaveProperty('processing_status');
    else expect(result.metadata.processing_status).toBe(rawValue);
  });
  it.each(['ready', 'queued', 'failed', 'ARCHIVED', '" "', 'true', '1', '[archived]', '{state: archived}'])('rejects unsupported Source stage value %s', value => {
    const result = parseMarkdown('20_Sources/status.md', Buffer.from(manualSource('body', `processing_status: ${value}\n`)));
    expect(result).toMatchObject({ state: 'invalid', processing_status: null, body_markdown: '', metadata: {} });
    expect(result.diagnostics[0]?.code).toBe('INVALID_PROCESSING_STATUS');
  });
  it.each(['pending', 'compiled', 'reviewed', 'planned', 'archived'])('reads %s independently of lifecycle', stage => {
    const result = parseMarkdown('20_Sources/status.md', Buffer.from(manualSource('body', `processing_status: ${stage}\nlifecycle_status: discarded\n`)));
    expect(result).toMatchObject({ state: 'ready', processing_status: stage, lifecycle_status: 'discarded', body_markdown: 'body' });
  });
  it.each(['', 'lifecycle_status: null\n', 'lifecycle_status: ""\n', 'lifecycle_status: active\n'])('defaults lifecycle for %j without adding properties', line => {
    expect(parseMarkdown('40_Knowledge/k.md', Buffer.from(`---\ntags: []\n${line}---\nKnowledge`))).toMatchObject({ lifecycle_status: 'active', body_markdown: 'Knowledge' });
  });
  it.each(['failed', 'pending', 'true', '1', '[active]'])('rejects invalid lifecycle %s for both supported kinds', value => {
    for (const relative of ['20_Sources/status.md', '40_Knowledge/k.md']) {
      const text = relative.startsWith('20_Sources') ? manualSource('body', `lifecycle_status: ${value}\n`) : `---\nlifecycle_status: ${value}\n---\nbody`;
      expect(parseMarkdown(relative, Buffer.from(text))).toMatchObject({ state: 'invalid', lifecycle_status: null, diagnostics: [{ code: 'INVALID_LIFECYCLE_STATUS' }] });
    }
  });
  it('reads a derived R3 with original fields and body intact without modifying R1', async () => {
    const sample = realSamples[0]!;
    const original = parseMarkdown(sample.path, await realBytes(sample.path));
    const r3 = await archivedSample(sample);
    const derived = parseMarkdown('20_Sources/R3/archived.md', r3);
    expect(derived).toMatchObject({ state: 'ready', processing_status: 'archived', annotation: original.annotation, body_markdown: original.body_markdown });
    expect(derived.metadata).toEqual({ ...original.metadata, processing_status: 'archived', lifecycle_status: 'active' });
    expect(sha256(await realBytes(sample.path))).toBe(sample.hash);
  });
});
