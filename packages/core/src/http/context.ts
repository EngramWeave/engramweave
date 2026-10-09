import type Database from 'better-sqlite3';
import type { ScanJobs } from '../jobs/scans.js';
import type { CompilerJobs } from '../jobs/compiler.js';
import type { SourceBatches } from '../jobs/source-batches.js';
import type { SemanticRecall } from '../recall/index.js';
import type { AnalyzerJobs } from '../jobs/analyzer.js';
import type { DraftPublications } from '../review/publication.js';
import type { ProcessingRounds } from '../jobs/processing-rounds.js';
import type { ProcessingSettingsStore } from '../processing/settings.js';
import type { ProcessingScheduler } from '../processing/scheduler.js';
import type { RecompileActions } from '../review/recompile.js';

export interface CoreServices { db: Database.Database; jobs: ScanJobs; compiler?: CompilerJobs; batches?: SourceBatches; recall?: SemanticRecall; analyzer?: AnalyzerJobs; publications?: DraftPublications;
  processing?: ProcessingRounds; processingSettings?: ProcessingSettingsStore; scheduler?: ProcessingScheduler; recompile?: RecompileActions; instance_id: string }
