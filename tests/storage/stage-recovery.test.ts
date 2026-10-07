import { afterEach, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROCESSING_STATUSES } from '@engramweave/contracts';
import { recoverDatabase } from '../../packages/core/src/storage/recover.js';
import { httpRuntime, httpCore, submitScan, finishedJob } from '../helpers/http.js';
import { manualSource, writeDocument } from '../helpers/fixtures.js';
import { assetHashes, semanticSnapshot } from '../helpers/recovery.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it.each(['missing', 'corrupt'])('reconstructs all stages and lifecycles from files after %s SQLite', async scenario => {
  const runtime = await httpRuntime(async vault => {
    for (const stage of PROCESSING_STATUSES) await writeDocument(vault, `20_Sources/${stage}.md`, manualSource(`Body ${stage}`, `processing_status: ${stage}\nlifecycle_status: ${stage === 'compiled' ? 'discarded' : 'active'}\nannotation: Context ${stage}\n`));
    await writeDocument(vault, '20_Sources/empty.md', manualSource('Historical material', 'processing_status: null\nannotation: Historical annotation\n'));
    await writeDocument(vault, '40_Knowledge/K1.md', '---\nlifecycle_status: discarded\n---\nKnowledge');
    await writeDocument(vault, '30_Drafts/user.md', '---\nlifecycle_status: discarded\n---\nUser edits');
  }); cleanups.push(runtime.cleanup);
  const scan = await submitScan(runtime.request); expect(await finishedJob(runtime.request, scan.job.id)).toMatchObject({ status: 'succeeded' });
  const snapshot = await semanticSnapshot(runtime.request);
  const hashes = await assetHashes(runtime.config.vault_path);
  expect(snapshot.documents['20_Sources/empty.md']).toMatchObject({ processing_status: 'pending', annotation: 'Historical annotation' });
  await runtime.core.close();
  const database = path.join(runtime.config.data_dir, 'core.sqlite');
  if (scenario === 'missing') await rm(database);
  else {
    await writeFile(database, 'Corrupt SQLite');
    expect(await recoverDatabase(runtime.config)).toMatchObject({ job: { status: 'succeeded' } });
  }
  const rebuilt = await httpCore(runtime.config); cleanups.push(rebuilt.core.close);
  if (scenario === 'missing') {
    const job = await submitScan(rebuilt.request, 'rebuild'); expect(await finishedJob(rebuilt.request, job.job.id)).toMatchObject({ status: 'succeeded' });
  }
  expect(await semanticSnapshot(rebuilt.request)).toEqual(snapshot);
  expect(await assetHashes(runtime.config.vault_path)).toEqual(hashes);
  expect(await readFile(path.join(runtime.config.vault_path, '30_Drafts/user.md'), 'utf8')).toContain('User edits');
});
