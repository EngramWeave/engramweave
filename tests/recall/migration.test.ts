import { expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';
import { writeDocument, manualSource } from '../helpers/fixtures.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { legacyDatabase } from '../helpers/legacy-database.js';
import { allDocuments } from '../../packages/core/src/storage/registry.js';
import { sourceRelations } from '../../packages/core/src/storage/source-relations.js';
import { retainWindowsAttributes } from '../../packages/core/src/files/windows.js';

it.each([1, 2] as const)('migrates v%s preserving Source identity, lifecycle, jobs and bytes, then registers ordinary Idea/Research with provenance', async version => {
  const runtime = await isolatedRuntime(); await mkdir(runtime.config.data_dir);
  await writeDocument(runtime.config.vault_path, '20_Sources/record.md', manualSource('Original', 'processing_status: compiled\n'));
  let db = await openDatabase(runtime.config); const lease = retainWindowsAttributes();
  try {
    let jobs = new ScanJobs(db, runtime.config.vault_path); jobs.submit('refresh'); await jobs.close();
    const before = allDocuments(db); const sourceBytes = await readFile(path.join(runtime.config.vault_path, '20_Sources/record.md'));
    legacyDatabase(db, version); db.close();
    db = await openDatabase(runtime.config); expect(allDocuments(db)).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
    const idea = '# Plain Idea\nExperiment'; const research = '---\nsources: "[[20_Sources/record]]"\n---\n# Research\nEvidence';
    await writeDocument(runtime.config.vault_path, '10_Ideas/plain.md', idea); await writeDocument(runtime.config.vault_path, '50_Research/plain.md', research);
    jobs = new ScanJobs(db, runtime.config.vault_path); const scan = jobs.submit('refresh'); await jobs.close(); expect(jobs.get(scan.job.id)!.status).toBe('succeeded');
    expect(allDocuments(db).map(row => row.kind)).toEqual(['idea', 'source', 'research']);
    expect(await readFile(path.join(runtime.config.vault_path, '10_Ideas/plain.md'), 'utf8')).toBe(idea);
    expect(await readFile(path.join(runtime.config.vault_path, '50_Research/plain.md'), 'utf8')).toBe(research);
    expect(await readFile(path.join(runtime.config.vault_path, '20_Sources/record.md'))).toEqual(sourceBytes);
    const relations = sourceRelations(db, runtime.config.vault_path); await relations.refresh(true, true);
    expect(relations.targets('20_Sources/record.md').references).toEqual([expect.objectContaining({ path: '50_Research/plain.md' })]);
  } finally { if (db.open) db.close(); await lease(); await runtime.cleanup(); }
}, 30000);
