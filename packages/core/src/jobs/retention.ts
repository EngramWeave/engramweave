import type Database from 'better-sqlite3';
import { LIMITS } from '@engramweave/contracts';

/** Only completed Job rows are disposable; active Jobs and assets are untouched. */
export function retainFinishedJobs(db: Database.Database) {
  db.prepare(`DELETE FROM jobs WHERE status NOT IN ('queued','running') AND id NOT IN (
    SELECT id FROM jobs WHERE status NOT IN ('queued','running')
    ORDER BY finished_at DESC,created_at DESC,id ASC LIMIT ?
  )`).run(LIMITS.retained_finished_jobs);
}
