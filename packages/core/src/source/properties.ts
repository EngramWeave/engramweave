import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isScalar, parseDocument } from 'yaml';
import { LIMITS } from '@engramweave/contracts';
import { FileProblem } from '../files/read.js';
import { parseMarkdown } from './parse.js';

/** Deterministic byte edit shared by registration and Capture replay matching. */
export function pendingSourceBytes(relative: string, bytes: Buffer): Buffer {
  const before = parseMarkdown(relative, bytes);
  if (before.state !== 'ready' || before.kind !== 'source' || before.processing_status !== null) return bytes;
  const text = bytes.toString('utf8');
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  const opening = /^---\r?\n/.exec(text.slice(bom));
  if (!opening) throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Source properties cannot be safely located');
  const start = bom + opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text.slice(start));
  if (!closing) throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Source properties cannot be safely located');
  const yaml = parseDocument(text.slice(start, start + closing.index), { keepSourceTokens: true, version: '1.2', schema: 'core' });
  if (!isMap(yaml.contents)) throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Source properties must be a mapping');
  const pair = yaml.contents.items.find(item => isScalar(item.key) && item.key.value === 'processing_status');
  let from: number, to: number, replacement: string;
  if (pair) {
    const value = pair.value;
    if ((!isScalar(value) && !isAlias(value)) || !value.range) throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Stage property cannot be safely edited');
    from = start + value.range[0]; to = start + value.range[1];
    replacement = from === to ? 'pending ' : 'pending';
    if (isScalar(value) && value.srcToken?.type === 'block-scalar') {
      // Empty block scalars have no submitted text; preserve header comments and blank lines.
      const header = value.srcToken.props.find(token => token.type === 'block-scalar-header');
      if (header && 'source' in header) to = from + header.source.length;
    }
  } else if (yaml.contents.flow && yaml.contents.range) {
    from = to = start + yaml.contents.range[0] + 1;
    replacement = 'processing_status: pending, ';
  } else {
    from = to = start;
    let indent = '';
    if (yaml.contents.range) {
      const mappingStart = start + yaml.contents.range[0];
      const lineStart = text.lastIndexOf('\n', mappingStart - 1) + 1;
      const prefix = text.slice(lineStart, mappingStart);
      if (yaml.contents.anchor || yaml.contents.tag || /^ +$/.test(prefix)) {
        if (!/^ *$/.test(prefix)) throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Mapping indentation cannot be safely preserved');
        from = to = lineStart; indent = prefix;
      }
    }
    replacement = `${indent}processing_status: pending${opening[0].endsWith('\r\n') ? '\r\n' : '\n'}`;
  }
  const edited = Buffer.concat([bytes.subarray(0, Buffer.byteLength(text.slice(0, from))), Buffer.from(replacement), bytes.subarray(Buffer.byteLength(text.slice(0, to)))]);
  if (edited.length > LIMITS.markdown_bytes) throw new FileProblem('FILE_TOO_LARGE', 'unsupported', 'Normalized Markdown exceeds the file size limit');
  const after = parseMarkdown(relative, edited);
  const { processing_status: _old, ...oldMetadata } = before.metadata;
  const { processing_status: _new, ...newMetadata } = after.metadata;
  if (after.state !== 'ready' || after.processing_status !== 'pending' || !isDeepStrictEqual(oldMetadata, newMetadata)
    || before.annotation !== after.annotation || before.body_markdown !== after.body_markdown) {
    throw new FileProblem('PROPERTY_WRITE_UNSUPPORTED', 'invalid', 'Stage edit would change other Source content or properties');
  }
  return edited;
}
