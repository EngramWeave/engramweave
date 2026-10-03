import type Database from 'better-sqlite3';
import type { ScanJobs } from '../jobs/scans.js';

export interface CoreServices { db: Database.Database; jobs: ScanJobs; instance_id: string }
