import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from './runtime.js';
import { openDatabase } from '../../packages/core/src/storage/database.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { CompilerJobs, type CompilerExecutor } from '../../packages/core/src/jobs/compiler.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';
import { readMarkdown } from '../../packages/core/src/files/read.js';
import type Database from 'better-sqlite3';

export const sourcePath = '20_Sources/selected.md';
export const sourceText = '---\ntype: raw_source\nsource_type: paper\nsource: zotero://select/library/items/TEST123\nprocessing_status: pending # stage\nlifecycle_status: active\nannotation: "I understand that memory is reconstructed."\ncustom: preserve-me\n---\n\n# Selected material\n\nOnly this passage is submitted. The effect holds under condition A.\n';
export async function compilerFixture(executor: CompilerExecutor, text = sourceText): Promise<Awaited<ReturnType<typeof isolatedRuntime>> & { db: Database.Database; compiler: CompilerJobs; sourcePath: string; revision: string; close(): Promise<void> }> {
  const runtime = await isolatedRuntime();
  await mkdir(path.join(runtime.config.vault_path, '20_Sources'));
  await mkdir(runtime.config.data_dir);
  await writeFile(path.join(runtime.config.vault_path, sourcePath), text);
  const db = await openDatabase(runtime.config);
  let compiler: CompilerJobs;
  const scans = new ScanJobs(db, runtime.config.vault_path, () => compiler?.busy() ?? false);
  scans.submit('refresh'); await scans.close();
  compiler = new CompilerJobs(db, runtime.config, () => scans.active() !== null, executor);
  await compiler.initialize();
  await compiler.settings.save({ ...defaultSettings, model: 'fixture-model', codex_path: process.execPath });
  const input = await readMarkdown(runtime.config.vault_path, sourcePath);
  return { ...runtime, db, compiler, sourcePath, revision: input.revision, async close() { await compiler.close(); db.close(); await runtime.cleanup(); } };
}
export async function waitCompiler(compiler: CompilerJobs, id: string) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const job = compiler.get(id);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Compiler task did not terminate');
}
