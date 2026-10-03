import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../packages/core/src/source/parse.js';
import { manualSource, realBytes, realSamples, sha256 } from '../helpers/fixtures.js';

describe('Source and Knowledge parsing', () => {
  it.each(realSamples)('preserves the real sample $name without altering bytes', async sample => {
    const bytes = await realBytes(sample.path);
    const result = parseMarkdown(sample.path, bytes);
    expect(result.state).toBe('ready');
    expect(result.annotation).toBe('');
    expect(result.metadata).not.toHaveProperty('annotation');
    expect(result.metadata.author).toEqual([sample.author]);
    expect(result.metadata.published).toBe('2026-10-03');
    expect(result.captured_at).toBe('2026-10-03');
    expect(result.original_locator).toBe(sample.url);
    expect(result.metadata.description).toEqual(expect.any(String));
    expect(result.body_markdown).not.toContain(result.metadata.description);
    expect(sha256(bytes)).toBe(sample.hash);
    expect(sha256(await realBytes(sample.path))).toBe(sample.hash);
    if (sample.name.startsWith('把')) expect(result.body_markdown).toContain('573KB');
    else { expect(result.body_markdown).toContain('counter++'); expect(result.body_markdown).toContain('```text'); }
  });
  it('accepts BOM and CRLF while retaining raw body and unknown metadata', () => {
    const text = '\ufeff' + manualSource('# Heading\r\n\r\n```text\r\nA\r\n```\r\n', 'annotation: |\n  用户上下文\n  "quote"\ncustom:\n  nested: [true, null, 3]\n').replace(/(?<!\r)\n/g, '\r\n');
    const result = parseMarkdown('20_Sources/bom.md', Buffer.from(text));
    expect(result.state).toBe('ready');
    expect(result.title).toBe('Heading');
    expect(result.annotation).toBe('用户上下文\n"quote"\n');
    expect(result.metadata.custom).toEqual({ nested: [true, null, 3] });
    expect(result.body_markdown).toBe('# Heading\r\n\r\n```text\r\nA\r\n```\r\n');
  });
  it.each([
    ['duplicate', manualSource('body', 'source_type: web\n'), 'INVALID_YAML'],
    ['tag', manualSource('body', 'custom: !execute dangerous\n'), 'INVALID_YAML'],
    ['mapping', '---\n- array\n---\nbody', 'INVALID_METADATA'],
    ['unclosed', '---\ntype: raw_source\nbody', 'FRONTMATTER_UNCLOSED'],
    ['annotation', manualSource('body', 'annotation: [wrong]\n'), 'INVALID_ANNOTATION'],
    ['source_type', '---\ntype: raw_source\n---\nbody', 'INVALID_SOURCE_TYPE'],
    ['web URL', '---\ntype: raw_source\nsource_type: web\nsource: file:///C:/secret\n---\nbody', 'INVALID_LOCATOR'],
    ['author', manualSource('body', 'author: [name, 1]\n'), 'INVALID_LIST'],
    ['nonfinite', manualSource('body', 'custom: .inf\n'), 'INVALID_METADATA'],
  ])('excludes malformed %s without retaining searchable text', (_name, text, code) => {
    const result = parseMarkdown('20_Sources/error.md', Buffer.from(text));
    expect(result.state).toBe('invalid');
    expect(result.diagnostics[0]?.code).toBe(code);
    expect(result.body_markdown).toBe('');
  });
  it('rejects invalid UTF-8 and excessive or cyclic aliases', () => {
    expect(parseMarkdown('20_Sources/encoding.md', Buffer.from([0xc0, 0xaf])).diagnostics[0]?.code).toBe('INVALID_UTF8');
    const cycle = manualSource('body', 'custom: &a [*a]\n');
    expect(parseMarkdown('20_Sources/cycle.md', Buffer.from(cycle)).state).toBe('invalid');
    const expansion = manualSource('body', `a: &a x\nb: [${Array(51).fill('*a').join(', ')}]\n`);
    expect(parseMarkdown('20_Sources/aliases.md', Buffer.from(expansion)).state).toBe('invalid');
  });
  it('keeps unknown captured date and reports warnings without inventing a timestamp', () => {
    const result = parseMarkdown('20_Sources/date.md', Buffer.from('---\ntype: raw_source\nsource_type: manual\ncaptured_at: yesterday\n---\nbody'));
    expect(result.state).toBe('ready');
    expect(result.captured_at).toBe('yesterday');
    expect(result.diagnostics[0]?.code).toBe('CAPTURED_AT_FORMAT');
  });
  it('reads plain Knowledge, preserves complex provenance and excludes raw_source in Knowledge', () => {
    const result = parseMarkdown('40_Knowledge/plain.md', Buffer.from('# Existing knowledge\n\nContent'));
    expect(result).toMatchObject({ state: 'ready', kind: 'knowledge', title: 'Existing knowledge', asset: null });
    const complex = parseMarkdown('40_Knowledge/complex.md', Buffer.from('---\nsources: {unknown: true}\n---\nBody'));
    expect(complex.metadata.sources).toEqual({ unknown: true });
    expect(complex.diagnostics[0]?.code).toBe('UNSUPPORTED_PROVENANCE');
    expect(parseMarkdown('40_Knowledge/conflict.md', Buffer.from(manualSource())).diagnostics[0]?.code).toBe('DIRECTORY_TYPE_CONFLICT');
    expect(parseMarkdown('20_Sources/plain.md', Buffer.from('Plain note')).state).toBe('unsupported');
  });
  it('does not use headings inside fenced code as titles and rejects non-string mapping keys', () => {
    const result = parseMarkdown('40_Knowledge/title.md', Buffer.from('```md\n# Code title\n```\n\n# Real title #\n'));
    expect(result.title).toBe('Real title');
    const complexKey = manualSource('body', '? [array, key]\n: value\n');
    expect(parseMarkdown('20_Sources/key.md', Buffer.from(complexKey)).state).toBe('invalid');
    expect(parseMarkdown('20_Sources/asset.md', Buffer.from(manualSource('body', 'asset: javascript:execute\n'))).state).toBe('invalid');
  });
});
