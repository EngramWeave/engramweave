import { createHash } from 'node:crypto';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const terms = (text: string) => [...segmenter.segment(text.normalize('NFC').toLowerCase())].filter(part => part.isWordLike).map(part => part.segment);
export interface Chunk { chunk_id: string; heading: string; text: string; start_line: number; end_line: number; input: string; input_hash: string }
/** Byte limits are explicit conservative bounds, not purported exact model-token counts. */
export function splitChunks(path: string, title: string, body: string, bodyLine: number): Chunk[] {
  const chunks: Chunk[] = []; let heading = ''; let start = 0; let line = bodyLine; let startLine = line; let bytes = 0; let fence = '';
  const emit = (end: number, endLine: number) => {
    const text = body.slice(start, end);
    if (text.trim()) {
      const input = `${Array.from(title).slice(0, 120).join('')}\n${Array.from(heading).slice(0, 120).join('')}\n${text}`;
      chunks.push({ chunk_id: hash(`${path}\n${chunks.length}\n${text}`), heading, text, start_line: startLine, end_line: Math.max(startLine, endLine), input, input_hash: hash(input) });
    }
    start = end; startLine = line; bytes = 0;
  };
  // Cover every character, including a long single paragraph or fence. Never truncate a document tail.
  for (let offset = 0; offset < body.length;) {
    if (offset === 0 || body[offset - 1] === '\n') {
      const end = body.indexOf('\n', offset); const row = body.slice(offset, end < 0 ? body.length : end);
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(row)?.[1];
      if (marker) fence = fence && marker[0] === fence[0] && marker.length >= fence.length ? '' : fence || marker;
      if (!fence && /^ {0,3}#{1,6}\s/.test(row)) { emit(offset, line - 1); heading = row.trim(); }
    }
    const char = String.fromCodePoint(body.codePointAt(offset)!); const size = Buffer.byteLength(char);
    if (bytes + size > 800) emit(offset, line);
    bytes += size; offset += char.length;
    if (char === '\n') { line++; if (bytes >= 400 && (body[offset] === '\n' || offset === body.length)) emit(offset, line - 1); }
  }
  emit(body.length, line);
  return chunks;
}
