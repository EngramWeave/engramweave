import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Document, Source } from '@engramweave/contracts';
import { assetChain } from './assets.js';
import { archivedSample, realBytes, realSamples, sha256, writeDocument } from './fixtures.js';

export async function recoveryAssets(vault: string) {
  await assetChain(vault);
  const raw = await realBytes(realSamples[0]!.path);
  if (sha256(raw) !== realSamples[0]!.hash || !/^annotation:/m.test(raw.toString('utf8'))) throw new Error('R1 annotation baseline differs');
  const annotated = raw.toString('utf8').replace(/^annotation:[^\r\n]*(\r?)/m, (_line, cr) => `annotation: RecoveryContextR2${cr}`);
  await writeDocument(vault, '20_Sources/R2/annotated.md', annotated);
  await writeDocument(vault, '20_Sources/R3/archived.md', await archivedSample());
}
export async function assetHashes(vault: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (relative: string) => {
    for (const entry of await readdir(path.join(vault, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) hashes[child] = sha256(await readFile(path.join(vault, child)));
      else throw new Error('Recovery asset fixture contains a linked or special path');
    }
  };
  await visit('');
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
export async function semanticSnapshot(request: (route: string) => Promise<Response>) {
  const sources = await (await request('/v1/sources?limit=100')).json() as { items: Source[]; total: number };
  const documents: Record<string, Omit<Document, 'indexed_revision' | 'indexed_at' | 'index_generation' | 'index_stale'>> = {};
  for (const relative of [...sources.items.map(item => item.path), '40_Knowledge/K1.md']) {
    const document = await (await request(`/v1/documents?path=${encodeURIComponent(relative)}`)).json() as Document;
    const { indexed_revision: _revision, indexed_at: _at, index_generation: _generation, index_stale: _stale, ...semantic } = document;
    documents[relative] = semantic;
  }
  const queries = [
    'scope=sources&q=573KB&fields=body', 'scope=sources&q=counter%2B%2B&fields=body',
    'scope=sources&q=RecoveryContextR2&fields=annotation', 'q=provenance&fields=body',
    'scope=sources&q=apimanualword&fields=body', 'scope=sources&q=description&fields=body',
  ];
  const search: Record<string, unknown> = {};
  for (const query of queries) {
    const result = await (await request(`/v1/search?${query}`)).json() as { total: number; items: { id: string; [key: string]: unknown }[] };
    search[query] = { total: result.total, items: result.items.map(({ id: _id, ...semantic }) => semantic) };
  }
  return { sources: sources.items.map(({ id: _id, ...semantic }) => semantic), documents, search };
}
