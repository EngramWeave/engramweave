import { describe, expect, it } from 'vitest';
import { pendingSourceBytes, registeredSourceBytes } from '../../packages/core/src/source/properties.js';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { manualSource } from '../helpers/fixtures.js';

const relative = '20_Sources/status.md';
it.each(['', 'lifecycle_status: null\n', 'lifecycle_status: ""\n', 'lifecycle_status: active\n', 'lifecycle_status: discarded\n'])('normalizes lifecycle without changing an existing compiled stage, Annotation or body (%s)', property => {
  const text = manualSource('Unchanged body\n---\nMore body', `processing_status: compiled\nannotation: Keep exactly\nunknown: {key: value}\n${property}`).replace('lifecycle_status: active\n', property ? 'lifecycle_status: active\n' : '');
  const original = Buffer.from(text);
  const updated = registeredSourceBytes(relative, original);
  const before = parseMarkdown(relative, original), after = parseMarkdown(relative, updated);
  expect(after.processing_status).toBe('compiled');
  expect(after.metadata.lifecycle_status).toBe(property.includes('discarded') ? 'discarded' : 'active');
  expect(after.body_markdown).toBe(before.body_markdown); expect(after.annotation).toBe(before.annotation);
  expect(after.metadata.unknown).toEqual(before.metadata.unknown);
  expect(registeredSourceBytes(relative, updated)).toBe(updated);
});
describe('minimal Source stage normalization', () => {
  it.each(['\n', '\r\n'])('inserts one property while preserving BOM, comments, Unicode and %j bytes', newline => {
    const content = '\uFEFF' + manualSource('原文\n---\nprocessing_status: body text', '# Before\nannotation: |\n  用户理解\n  More context\nunknown: {key: value}\n').replaceAll('\n', newline);
    const bytes = Buffer.from(content);
    const expected = Buffer.from(content.replace(`---${newline}`, `---${newline}processing_status: pending${newline}`));
    expect(pendingSourceBytes(relative, bytes)).toEqual(expected);
    expect(pendingSourceBytes(relative, expected)).toBe(expected);
    expect(parseMarkdown(relative, expected)).toMatchObject({ processing_status: 'pending', annotation: `用户理解\nMore context\n`, lifecycle_status: 'active' });
  });
  it.each(['null', '~', '""', "''", ''])('replaces empty scalar %j without rewriting its comment or other fields', value => {
    const bytes = Buffer.from(manualSource('body', `"processing_status": ${value} # keep\nannotation: My note\n`));
    const result = pendingSourceBytes(relative, bytes);
    expect(result.toString()).toMatch(/processing_status": +pending/);
    expect(result.toString()).toContain('# keep\nannotation: My note\n');
    expect(parseMarkdown(relative, result)).toMatchObject({ state: 'ready', processing_status: 'pending', annotation: 'My note', body_markdown: 'body' });
  });
  it('supports flow mappings without changing their layout', () => {
    const bytes = Buffer.from('---\n{type: raw_source, source_type: manual, annotation: 中文}\n---\nbody');
    expect(pendingSourceBytes(relative, bytes).toString()).toBe('---\n{processing_status: pending, type: raw_source, source_type: manual, annotation: 中文}\n---\nbody');
  });
  it.each(['|', '>-'])('fills an empty block scalar %s while retaining its comment and blank lines', header => {
    const bytes = Buffer.from(manualSource('body', `processing_status: ${header} # keep\n  \nannotation: Note\n`));
    const result = pendingSourceBytes(relative, bytes);
    expect(result.toString()).toBe(bytes.toString().replace(`processing_status: ${header}`, 'processing_status: pending'));
    expect(parseMarkdown(relative, result)).toMatchObject({ state: 'ready', processing_status: 'pending', annotation: 'Note' });
  });
  it('refuses an anchored stage whose alias would change another property', () => {
    const bytes = Buffer.from(manualSource('body', 'processing_status: &stage null\nother: *stage\n'));
    expect(() => pendingSourceBytes(relative, bytes)).toThrow();
    expect(parseMarkdown(relative, bytes).metadata.other).toBeNull();
  });
  it('fills a null alias value without changing its anchor or other aliases', () => {
    const bytes = Buffer.from(manualSource('body', 'empty: &empty null\nprocessing_status: *empty\nother: *empty\n'));
    const result = pendingSourceBytes(relative, bytes);
    expect(result.toString()).toBe(bytes.toString().replace('processing_status: *empty', 'processing_status: pending'));
    expect(parseMarkdown(relative, result)).toMatchObject({ state: 'ready', processing_status: 'pending', metadata: { empty: null, other: null } });
  });
  it.each(['&root\n', '!!map\n', '  '])('fills a missing stage inside block mapping properties %j', prefix => {
    const indented = prefix === '  ';
    const yaml = indented ? '  type: raw_source\n  source_type: manual\n  unknown: preserved\n' : prefix + 'type: raw_source\nsource_type: manual\nunknown: preserved\n';
    const original = Buffer.from(`---\n${yaml}---\nbody`);
    const updated = pendingSourceBytes(relative, original);
    expect(parseMarkdown(relative, updated)).toMatchObject({ state: 'ready', processing_status: 'pending', metadata: { unknown: 'preserved' }, body_markdown: 'body' });
    expect(updated.toString().replace(`${indented ? '  ' : ''}processing_status: pending\n`, '')).toBe(original.toString());
  });
  it('does not normalize invalid files, Knowledge or an existing stage', () => {
    for (const bytes of [Buffer.from(manualSource('body', 'processing_status: failed\n')), Buffer.from(manualSource('body', 'processing_status: compiled\nlifecycle_status: discarded\n'))]) {
      expect(pendingSourceBytes(relative, bytes)).toBe(bytes);
    }
    const knowledge = Buffer.from('# Knowledge');
    expect(pendingSourceBytes('40_Knowledge/k.md', knowledge)).toBe(knowledge);
  });
});
