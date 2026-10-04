import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { archivedSample, manualSource, realBytes, realSamples, sha256 } from '../helpers/fixtures.js';

describe('read-only Source archival property', () => {
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
  it.each(['ready', 'queued', 'compiled', 'ARCHIVED', '" "', 'true', '1', '[archived]', '{state: archived}'])('rejects unsupported Source archival value %s', value => {
    const result = parseMarkdown('20_Sources/status.md', Buffer.from(manualSource('body', `processing_status: ${value}\n`)));
    expect(result).toMatchObject({ state: 'invalid', processing_status: null, body_markdown: '', metadata: {} });
    expect(result.diagnostics[0]?.code).toBe('INVALID_PROCESSING_STATUS');
  });
  it('reads a derived R3 with original fields and body intact without modifying R1', async () => {
    const sample = realSamples[0]!;
    const original = parseMarkdown(sample.path, await realBytes(sample.path));
    const r3 = await archivedSample(sample);
    const derived = parseMarkdown('20_Sources/R3/archived.md', r3);
    expect(derived).toMatchObject({ state: 'ready', processing_status: 'archived', annotation: original.annotation, body_markdown: original.body_markdown });
    expect(derived.metadata).toEqual({ ...original.metadata, processing_status: 'archived' });
    expect(sha256(await realBytes(sample.path))).toBe(sample.hash);
  });
});
