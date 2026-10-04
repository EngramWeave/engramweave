import { readFile } from 'node:fs/promises';
import { openDatabase } from '../../packages/core/dist/storage/database.js';
import { ScanJobs } from '../../packages/core/dist/jobs/scans.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const db = await openDatabase(config);
const jobs = new ScanJobs(db, config.vault_path);
let id;
if (process.argv[3] === 'before_commit') {
  db.function('publication_gate', () => {
    process.send({ phase: 'before_commit', id });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return 0;
  });
  db.exec('CREATE TEMP TRIGGER publication_gate BEFORE UPDATE OF index_generation ON meta BEGIN SELECT publication_gate(); END;');
}
id = jobs.submit('refresh').job.id;
await jobs.close();
process.send({ phase: 'after_commit', id });
// Keep the connection open until the parent forcibly terminates this owned child.
setInterval(() => {}, 1000);
