import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

const originalRoot = 'C:/Users/18214/Downloads/testEW/testEW';
const destination = path.resolve('.local/fixtures/r1-vault');
const samples = [
  ['把 OpenClaw.NET 的 83 篇 Markdown 变成一个网站：完整复盘.md', 1244, '6A46D92D9C03BB1C86D5DFF939D5C68B9A4F84F139EEBF13EA90B0ACA783BB63', 'CRLF'],
  ['并发编程（七）：volatile——从语言规则到 CPU.md', 1203, '10BFE3381131ACAD9BEF633EB64A78C4277199F5DA46600109F7C7F7C2DB6E14', 'LF'],
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const evidence = [];
const baselines = [];
for (const [name, size, expected, newline] of samples) {
  const relative = `20_Sources/Web/2026-10/${name}`;
  const original = path.join(originalRoot, relative);
  const target = path.join(destination, relative);
  const bytes = await readFile(original);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const content = bytes.toString('utf8');
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  if (bytes.length !== size || hash(bytes) !== expected ||
      bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
      (newline === 'CRLF' ? crlf === 0 || lf !== 0 : crlf !== 0 || lf === 0)) {
    throw new Error(`Original baseline mismatch: ${relative}; do not alter original`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  try { await writeFile(target, bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (hash(await readFile(target)) !== expected) throw new Error(`Fixture differs: ${target}`);
  if (hash(await readFile(original)) !== expected) throw new Error(`Original changed: ${original}`);
  evidence.push({ path: relative, bytes: size, sha256: expected, encoding: 'UTF-8 without BOM', newline, crlf, lf, original_unchanged: true, copy_identical: true });
  // Baseline verification uses YAML directly and is independent of the product parser.
  const parts = content.split(/^---\r?$/m);
  assert.equal(parts.length, 3);
  const metadata = parseDocument(parts[1], { version: '1.2', schema: 'core', uniqueKeys: true }).toJS({ maxAliasCount: 50 });
  const first = name.startsWith('把 OpenClaw.NET');
  const source = first ? 'https://www.cnblogs.com/shanyou/p/23192862' : 'https://www.cnblogs.com/ThinkerQAQ/p/23192943';
  const author = first ? '张善友' : 'ThinkerQAQ';
  const titleTerm = first ? 'OpenClaw.NET' : 'volatile';
  const bodyTerm = first ? '573KB' : 'counter++';
  assert.equal(metadata.type, 'raw_source');
  assert.equal(metadata.source_type, 'web');
  assert.equal(metadata.captured_at, '2026-10-03');
  assert.equal(metadata.published, '2026-10-03');
  assert.equal(metadata.annotation, null);
  assert.deepEqual(metadata.author, [author]);
  assert.equal(metadata.source, source);
  assert.equal(typeof metadata.description, 'string');
  assert.ok(!parts[2].includes(metadata.description));
  assert.ok(metadata.title.includes(titleTerm));
  assert.ok(parts[2].includes(bodyTerm));
  baselines.push({ path: relative, type: metadata.type, source_type: metadata.source_type, captured_at: metadata.captured_at,
    published: metadata.published, annotation_yaml: null, annotation_read_model_expected: '', author: metadata.author,
    source, description_present_in_metadata: true, description_not_in_body: true,
    title_query: titleTerm, body_query: bodyTerm });
}
let knowledgePresent = true;
try { await access(path.join(originalRoot, '40_Knowledge')); }
catch (error) { if (error.code !== 'ENOENT') throw error; knowledgePresent = false; }
const report = { original_root: originalRoot, private_copy: destination, sharing: 'private, do not commit originals or copies', original_40_knowledge_present: knowledgePresent, samples: evidence };
// Validation evidence is local-only, like the private fixture copies it describes.
const evidenceDir = path.resolve('.local/p1/evidence');
await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, 't00-fixture-hashes.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(evidenceDir, 't00-baseline.json'), `${JSON.stringify({
  verification: 'Original fixture baseline with installed YAML library, independent of the product parser',
  expected_source_count: 2, expected_knowledge_count: 0, actual_scan_executed: false, records: baselines,
}, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
