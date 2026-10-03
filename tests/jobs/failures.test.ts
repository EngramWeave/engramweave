import { afterEach, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { openDatabase, indexMeta } from '../../packages/core/src/storage/database.js';
import { ScanJobs } from '../../packages/core/src/jobs/scans.js';
import { isolatedRuntime } from '../helpers/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const isolated = await isolatedRuntime(); cleanups.push(isolated.cleanup);
  await mkdir(isolated.config.data_dir);
  const db = await openDatabase(isolated.config); cleanups.push(async () => { if (db.open) db.close(); });
  return { db, jobs: new ScanJobs(db, isolated.config.vault_path) };
}

describe('scan database failure boundaries', () => {
  it('records a failed Job when the running transition fails, without publishing an index', async () => {
    const { db, jobs } = await fixture();
    db.exec("CREATE TRIGGER reject_running BEFORE UPDATE OF status ON jobs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;");
    const { job } = jobs.submit('refresh');
    await jobs.close();
    expect(jobs.get(job.id)).toMatchObject({ status: 'failed', summary: null, error: { code: 'IO_ERROR' } });
    expect(indexMeta(db).index_generation).toBe(0);
  });
  it('handles a background rejection and reports an unwritable failure status during shutdown', async () => {
    const { db, jobs } = await fixture();
    db.exec("CREATE TRIGGER reject_job_write BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'injected database failure'); END;");
    const { job } = jobs.submit('refresh');
    await nextTurn(); await nextTurn();
    await expect(jobs.close()).rejects.toMatchObject({ code: 'DATABASE_ERROR', message: 'Scan failure could not be persisted' });
    expect(jobs.get(job.id)).toMatchObject({ status: 'queued', summary: null });
    expect(indexMeta(db).index_generation).toBe(0);
  });
});
