import { manualSource, realSamples, writeDocument, copyRealSamples } from './fixtures.js';

export const assetPath = '20_Sources/A1/pixel.png';
export const recordPath = '20_Sources/A1/pixel.source.md';
export const knowledgePath = '40_Knowledge/K1.md';
export const assetBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
export async function assetChain(vault: string) {
  await copyRealSamples(vault);
  await writeDocument(vault, assetPath, assetBytes);
  await writeDocument(vault, recordPath, manualSource('Record description only', 'source_type: image\nasset: "[[./pixel.png#image|original pixel]]"\nannotation: User annotation\n').replace('source_type: manual\n', ''));
  await writeDocument(vault, '20_Sources/A1/external.source.md', manualSource('External record description', 'source: zotero://select/library/items/ABC\n'));
  await writeDocument(vault, knowledgePath, `---\nsources: ${JSON.stringify([`[[${realSamples[0]!.path.slice(0, -3)}#intro|R1]]`, `[[${recordPath.slice(0, -3)}|A1]]`])}\n---\n# Existing knowledge\n\nLocal provenance chain.`);
}
