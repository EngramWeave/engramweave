import type Database from 'better-sqlite3';
import { LIMITS } from '@engramweave/contracts';

/** Only completed Job rows are disposable; active Jobs and assets are untouched. */
export function retainFinishedJobs(db: Database.Database) {
  const protectedIds = processingDependencies(db);let count=0;
  for(const row of db.prepare("SELECT id FROM jobs WHERE status NOT IN ('queued','running') ORDER BY finished_at DESC,created_at DESC,id ASC").all() as {id:string}[]) if(!protectedIds.has(row.id)&&++count>LIMITS.retained_finished_jobs) db.prepare('DELETE FROM jobs WHERE id=?').run(row.id);
}

export function processingDependencies(db: Database.Database): Set<string> {
  const ids = new Set<string>();
  for (const row of db.prepare('SELECT round_json FROM processing_rounds').all() as { round_json: string }[]) {
    const round=JSON.parse(row.round_json);if(round.registration_job_id) ids.add(round.registration_job_id);
    for (const item of round.items) for (const id of [item.compiler_job_id, item.analyzer_job_id]) if (id) ids.add(id);
  }
  return ids;
}

export function interruptAttempts(db: Database.Database) {
  for (const row of db.prepare("SELECT job_id,task,number,attempt_json FROM execution_attempts WHERE json_extract(attempt_json,'$.status')='running'").all() as { job_id: string; task: string; number: number; attempt_json: string }[]) {
    const attempt = JSON.parse(row.attempt_json); attempt.status = 'interrupted'; attempt.finished_at = new Date().toISOString(); attempt.next_retry_at = null;
    db.prepare('UPDATE execution_attempts SET attempt_json=? WHERE job_id=? AND task=? AND number=?').run(JSON.stringify(attempt), row.job_id, row.task, row.number);
  }
}
