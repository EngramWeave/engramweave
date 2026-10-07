import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const realSamples = [
  { name: '把 OpenClaw.NET 的 83 篇 Markdown 变成一个网站：完整复盘.md', hash: '6a46d92d9c03bb1c86d5dff939d5c68b9a4f84f139eebf13ea90b0aca783bb63', url: 'https://www.cnblogs.com/shanyou/p/23192862', author: '张善友' },
  { name: '并发编程（七）：volatile——从语言规则到 CPU.md', hash: '10bfe3381131acad9bef633eb64a78c4277199f5da46600109f7c7f7c2db6e14', url: 'https://www.cnblogs.com/ThinkerQAQ/p/23192943', author: 'ThinkerQAQ' },
].map(sample => ({ ...sample, path: `20_Sources/Web/2026-10/${sample.name}` }));
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function realBytes(relative: string) { return readFile(path.resolve('.local/fixtures/r1-vault', relative)); }
/** R3 is a derived test input: one archive line inserted into an unchanged R1 copy. */
export async function archivedSample(sample = realSamples[0]!) {
  const original = await realBytes(sample.path);
  if (sha256(original) !== sample.hash) throw new Error('Real fixture differs from its baseline');
  const newline = original.subarray(0, 5).toString('utf8') === '---\r\n' ? '\r\n' : '\n';
  const opening = Buffer.from(`---${newline}`);
  if (!original.subarray(0, opening.length).equals(opening)) throw new Error('Real fixture has no Frontmatter');
  return Buffer.concat([opening, Buffer.from(`processing_status: archived${newline}`), original.subarray(opening.length)]);
}
/** Expected registered R1: precisely one inserted stage line, no production writer involved. */
export async function pendingSample(sample = realSamples[0]!) {
  return Buffer.from((await archivedSample(sample)).toString('utf8').replace('processing_status: archived', 'processing_status: pending'));
}
export async function copyRealSamples(vault: string) {
  for (const sample of realSamples) {
    const target = path.join(vault, sample.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.resolve('.local/fixtures/r1-vault', sample.path), target);
  }
}
export async function writeDocument(vault: string, relative: string, content: string | Buffer) {
  const { writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
  await writeFile(path.join(vault, relative), content);
}
export const manualSource = (body = 'Original text', extra = '') => `---\ntype: raw_source\nsource_type: manual\ncaptured_at: 2026-10-03\n${extra}---\n${body}`;
