import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { AnalyzerJobSchema, AnalyzeRequestSchema, AnalysisProfileSchema, type AnalyzerJob, type AnalyzeRequest, type ReviewResult, type RelationResult } from '@engramweave/contracts';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { windowsAttributes } from '../files/windows.js';
import { CoreError } from '../errors.js';
import type { AnalysisSnapshot, AnalysisEvidence } from './input.js';
import { analysisOutput } from './output.js';
import { parseTemplate } from './templates.js';

export interface AnalysisRecord {
  version: 1; request: AnalyzeRequest; job: AnalyzerJob; snapshot: AnalysisSnapshot;
  review: { result: ReviewResult | null; evidence: AnalysisEvidence; observations: unknown[] };
  relation: { result: RelationResult | null; evidence: AnalysisEvidence; observations: unknown[] };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class AnalysisResults {
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.join(directory, 'analysis-results'); }
  private id(id: string) { if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new CoreError('VALIDATION_ERROR', 'Invalid analysis run ID', 400); return id; }
  async initialize(create = false) {
    if (create) await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([this.directory]))[0]?.reparse) throw new CoreError('CONFIG_ERROR', 'Analysis result directory is unsafe', 400);
    return true;
  }
  async save(record: AnalysisRecord) {
    await this.initialize(true);
    const directory = path.join(this.directory, this.id(record.job.id));
    await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([directory]))[0]?.reparse) throw new CoreError('CONFIG_ERROR', 'Analysis run directory is unsafe', 400);
    // The complete receipt is atomic: output and its frozen provenance cannot diverge.
    const payload = JSON.stringify(record);
    await atomicWrite(path.join(directory, 'record.json'), JSON.stringify({ payload, digest: digest(payload) }), 8_000_000);
  }
  async read(id: string): Promise<AnalysisRecord> {
    await this.initialize();
    const directory = path.join(this.directory, this.id(id));
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([directory]))[0]?.reparse) throw new CoreError('JOB_NOT_FOUND', 'Analysis result is unavailable', 404);
    const bytes = await regularRead(path.join(directory, 'record.json'), 8_000_000);
    if (!bytes) throw new CoreError('JOB_NOT_FOUND', 'Analysis result is unavailable', 404);
    try {
      const envelope = JSON.parse(bytes.toString());
      if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.digest) throw new Error();
      const record: AnalysisRecord = JSON.parse(envelope.payload);
      if (record.version !== 1 || !Value.Check(AnalyzerJobSchema, record.job) || !Value.Check(AnalyzeRequestSchema, record.request) || !Value.Check(AnalysisProfileSchema, record.snapshot.profile)
        || record.job.id !== id || record.request.request_id !== id || record.job.source_path !== record.request.source_path || record.job.draft_path !== record.request.draft_path
        || record.snapshot.input.source.path !== record.request.source_path || record.snapshot.input.source.revision !== record.request.source_revision
        || record.snapshot.input.draft.path !== record.request.draft_path || record.snapshot.input.draft.revision !== record.request.draft_revision) throw new Error();
      for (const task of ['review','relation'] as const) {
        parseTemplate(record.snapshot.templates[task].content);
        if (!Array.isArray(record[task].evidence.items) || !Array.isArray(record[task].observations)) throw new Error();
        if (record[task].result) analysisOutput(JSON.stringify(record[task].result), task, record.snapshot, record[task].evidence);
      }
      return record;
    } catch { throw new CoreError('CONFIG_ERROR', 'Analysis receipt is invalid; preserved for inspection', 400); }
  }
  async ids() {
    if (!await this.initialize()) return [];
    const names = (await readdir(this.directory)).filter(name => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name));
    if (names.length > 10_000) throw new CoreError('PAYLOAD_TOO_LARGE', 'Analysis history exceeds recovery limit', 413);
    return names;
  }
  async remove(id: string) {
    // Only validated receipts in this owned directory can be pruned.
    await this.read(id);
    const directory = path.join(this.directory, this.id(id));
    if ((await readdir(directory)).join(',') !== 'record.json') throw new CoreError('CONFIG_ERROR', 'Unexpected analysis receipt artifacts are preserved', 400);
    await unlink(path.join(directory, 'record.json')); await rmdir(directory);
  }
}
