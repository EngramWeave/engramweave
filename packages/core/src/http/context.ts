import type Database from 'better-sqlite3';
import type { ScanJobs } from '../jobs/scans.js';
import type { CompilerJobs } from '../jobs/compiler.js';

export interface CoreServices { db: Database.Database; jobs: ScanJobs; compiler?: CompilerJobs; instance_id: string }
