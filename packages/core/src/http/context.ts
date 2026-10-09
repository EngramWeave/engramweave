import type Database from 'better-sqlite3';
import type { ScanJobs } from '../jobs/scans.js';
import type { CompilerJobs } from '../jobs/compiler.js';
import type { SourceBatches } from '../jobs/source-batches.js';
import type { SemanticRecall } from '../recall/index.js';
import type { AnalyzerJobs } from '../jobs/analyzer.js';
import type { DraftPublications } from '../review/publication.js';

export interface CoreServices { db: Database.Database; jobs: ScanJobs; compiler?: CompilerJobs; batches?: SourceBatches; recall?: SemanticRecall; analyzer?: AnalyzerJobs; publications?: DraftPublications; instance_id: string }
