import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { RecompileRequestSchema, type Config, type RecompileRequest, type RecompileResponse } from '@engramweave/contracts';
import type Database from 'better-sqlite3';
import { CoreError } from '../errors.js';
import { readMarkdown } from '../files/read.js';
import { editScalarProperty } from '../files/property-scalars.js';
import { PropertyNative } from '../files/property-native.js';
import { recoverPropertyJournal, isPropertyJournal, writeSourceProperties } from '../files/properties.js';
import { resolveVaultDirectory } from '../files/paths.js';
import { windowsAttributes } from '../files/windows.js';
import { parseMarkdown } from '../source/parse.js';
import { readDraft } from '../drafts/files.js';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { updateCompiledSource } from '../storage/registry.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
interface RecompileRecord { version: 1; request: RecompileRequest; before: string; after: string; source_bytes: string; completed: boolean; created_at: string }
export class RecompileActions {
  private writing = false;
  private stopping = false;
  private readonly idle: (() => void)[] = [];
  private readonly unfinished = new Set<string>();
  private readonly directory: string;
  constructor(private readonly config: Config, private readonly db: Database.Database, private readonly otherBusy: () => boolean) { this.directory = path.join(config.data_dir, 'recompile-actions'); }
  busy() { return this.writing || this.unfinished.size > 0; }
  count(relative: string) { return (this.db.prepare('SELECT count(*) AS count FROM recompile_actions WHERE path_key=?').get(relative.toLowerCase()) as { count: number }).count; }
  private async ready(create = false) {
    if (create) await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || (await windowsAttributes([this.directory]))[0]?.reparse) throw new CoreError('CONFIG_ERROR', 'Recompile action directory is unsafe', 400);
    return true;
  }
  private file(id: string) { if (!idPattern.test(id)) throw new CoreError('VALIDATION_ERROR', 'Invalid Recompile ID', 400); return path.join(this.directory, `${id}.json`); }
  private async save(record: RecompileRecord) { await this.ready(true); await atomicWrite(this.file(record.request.request_id), JSON.stringify(record), 8_000_000); }
  private async read(id: string): Promise<RecompileRecord | null> {
    if (!await this.ready()) return null;
    const bytes = await regularRead(this.file(id), 8_000_000); if (!bytes) return null;
    try {
      const record: RecompileRecord = JSON.parse(bytes.toString());
      if (record.version !== 1 || !Value.Check(RecompileRequestSchema, record.request) || record.request.request_id !== id || typeof record.completed !== 'boolean'
        || record.before !== record.request.source_revision || !/^[a-f0-9]{64}$/.test(record.after) || typeof record.source_bytes !== 'string' || hash(Buffer.from(record.source_bytes, 'base64')) !== record.after || !Number.isFinite(Date.parse(record.created_at))) throw new Error();
      return record;
    } catch { throw new CoreError('CONFIG_ERROR', 'Recompile receipt is invalid; preserved for inspection', 400); }
  }
  async initialize() {
    if (!await this.ready()) return;
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5)));
    if (names.length > 10000) throw new CoreError('CONFIG_ERROR', 'Recompile history exceeds its recovery bound', 400);
    for (const name of names) {
      const record = (await this.read(name.slice(0,-5)))!;
      if (record.completed) this.recordCount(record);
      else { this.unfinished.add(record.request.request_id); try { await this.finish(record); } catch { /* Preserve unresolved input; block competing mutations until it is restored. */ } }
    }
  }
  private recordCount(record: RecompileRecord) { this.db.prepare('INSERT OR IGNORE INTO recompile_actions VALUES(?,?,?,?)').run(record.request.request_id, record.request.source_path.toLowerCase(), record.request.source_path, record.created_at); }
  async submit(request: RecompileRequest): Promise<RecompileResponse> {
    if (this.writing || this.stopping) throw new CoreError('JOB_BUSY', 'A Recompile action is being saved or Core is stopping', 409);
    this.writing = true;
    try {
      let record = await this.read(request.request_id); const reused = Boolean(record);
      if (record && !isDeepStrictEqual(record.request, request)) throw new CoreError('PATH_CONFLICT', 'Recompile request ID belongs to different feedback or input', 409);
      if (record?.completed) { this.recordCount(record); return { path: request.source_path, revision: record.after, recompile_count: this.count(request.source_path), reused: true }; }
      if (this.otherBusy() || [...this.unfinished].some(id => id !== request.request_id)) throw new CoreError('JOB_BUSY', 'Finish the active operation or unresolved Recompile action', 409);
      if (!record) {
        const source = await readMarkdown(this.config.vault_path, request.source_path); const parsed = parseMarkdown(request.source_path, source.bytes);
        const draft = await readDraft(this.config.vault_path, request.draft_path);
        if (source.revision !== request.source_revision || draft.revision !== request.draft_revision) throw new CoreError('SOURCE_CHANGED', 'Source or Draft changed; read it again before Recompile', 409);
        if (parsed.state !== 'ready' || parsed.lifecycle_status !== 'active' || !['pending','compiled','reviewed'].includes(parsed.processing_status ?? '') || draft.lifecycle_status !== 'active'
          || !draft.sources.some(item => item.toLowerCase() === request.source_path.toLowerCase())) throw new CoreError('INVALID_SOURCE', 'Recompile requires an active unarchived Source and its active Draft', 422);
        let bytes = editScalarProperty(source.bytes, 'processing_status', 'pending');
        if (request.feedback.trim()) bytes = editScalarProperty(bytes, 'annotation', [parsed.annotation, request.feedback].filter(Boolean).join('\n\n'), true);
        record = { version: 1, request, before: source.revision, after: hash(bytes), source_bytes: bytes.toString('base64'), completed: false, created_at: new Date().toISOString() };
        await this.save(record); this.unfinished.add(request.request_id);
      }
      await this.finish(record);
      return { path: request.source_path, revision: record.after, recompile_count: this.count(request.source_path), reused };
    } finally { this.writing = false; for (const resolve of this.idle.splice(0)) resolve(); }
  }
  async close() { this.stopping = true; if (this.writing) await new Promise<void>(resolve => this.idle.push(resolve)); }
  private async finish(record: RecompileRecord) {
    const native = new PropertyNative(); const relative = record.request.source_path;
    try {
      const parent = path.posix.dirname(relative);
      for (const name of (await readdir(await resolveVaultDirectory(this.config.vault_path, parent))).filter(isPropertyJournal)) await recoverPropertyJournal(this.config.vault_path, parent, name, native);
      let source = await readMarkdown(this.config.vault_path, relative);
      if (![record.before, record.after].includes(source.revision)) throw new CoreError('SOURCE_CHANGED', 'Source changed during Recompile; preserve feedback receipt and restore its approved version', 409);
      if (source.revision !== record.after) source = await writeSourceProperties(this.config.vault_path, relative, source, Buffer.from(record.source_bytes,'base64'), native);
      updateCompiledSource(this.db, relative, source, parseMarkdown(relative, source.bytes));
      record.completed = true; await this.save(record); this.recordCount(record); this.unfinished.delete(record.request.request_id);
    } finally { await native.close(); }
  }
}
