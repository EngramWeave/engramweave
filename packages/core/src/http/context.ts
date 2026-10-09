import type Database from 'better-sqlite3';
import type { ScanJobs } from '../jobs/scans.js';
import type { CompilerJobs } from '../jobs/compiler.js';
import type { SourceBatches } from '../jobs/source-batches.js';
import type { SemanticRecall } from '../recall/index.js';

export interface CoreServices { db: Database.Database; jobs: ScanJobs; compiler?: CompilerJobs; batches?: SourceBatches; recall?: SemanticRecall; instance_id: string }
