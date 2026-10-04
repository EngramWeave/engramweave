import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Config, Job } from '@engramweave/contracts';
import { containsPath, validateConfig } from '../config.js';
import { CoreError } from '../errors.js';
import { acquireInstance } from '../instance.js';
import { windowsAttributes } from '../files/windows.js';
import { ScanJobs } from '../jobs/scans.js';
import { openDatabase } from './database.js';

const databaseNames = ['core.sqlite', 'core.sqlite-journal', 'core.sqlite-wal', 'core.sqlite-shm'] as const;
export interface RecoveryResult { backup_dir: string; isolated_files: string[]; job: Job }

/** Offline, explicit recovery: preserve the old database family, then rebuild only from files. */
export async function recoverDatabase(input: Config): Promise<RecoveryResult> {
  const config = await validateConfig(input);
  const instance = await acquireInstance(config);
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  let jobs: ScanJobs | undefined;
  const backup = path.join(config.data_dir, `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  const moved: string[] = [];
  let backupCreated = false;
  let rebuildJob: Job | undefined;
  try {
    const candidates: { name: typeof databaseNames[number]; ino: number }[] = [];
    for (const name of databaseNames) {
      const filename = path.join(config.data_dir, name);
      if (!containsPath(config.data_dir, filename) || containsPath(config.vault_path, filename)) throw new CoreError('CONFIG_ERROR', 'Recovery target is outside application data', 400);
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (await windowsAttributes([filename]))[0]?.reparse) {
          throw new CoreError('DATABASE_ERROR', 'Recovery requires regular unlinked database files');
        }
        candidates.push({ name, ino: info.ino });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // A freshly and exclusively created directory prevents overwriting an earlier backup.
    await mkdir(backup);
    backupCreated = true;
    for (const candidate of candidates) {
      const filename = path.join(config.data_dir, candidate.name);
      const current = await lstat(filename);
      if (current.ino !== candidate.ino || current.isSymbolicLink() || current.nlink !== 1) throw new CoreError('DATABASE_ERROR', 'Database identity changed during recovery');
      await rename(filename, path.join(backup, candidate.name));
      moved.push(candidate.name);
    }
    db = await openDatabase(config);
    jobs = new ScanJobs(db, config.vault_path);
    const submitted = jobs.submit('rebuild');
    await jobs.close();
    const job = jobs.get(submitted.job.id)!;
    rebuildJob = job;
    if (job.status !== 'succeeded') throw new CoreError('DATABASE_ERROR', 'Recovery rebuild failed; old backup and new diagnostics were preserved');
    return { backup_dir: backup, isolated_files: moved, job };
  } catch (error) {
    if (error instanceof CoreError && !backupCreated) throw error;
    throw new CoreError('DATABASE_ERROR', 'Recovery failed; preserve backup and remaining database files', 500, {
      backup_dir: backup, isolated_files: moved, cause_code: error instanceof CoreError ? error.code : 'IO_ERROR', rebuild_job: rebuildJob ?? null,
    });
  } finally {
    try { await jobs?.close(); } catch { /* The first close failure was already reported with recovery paths. */ }
    try { db?.close(); } finally { await instance.close(); }
  }
}
