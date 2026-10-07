import { lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { LIMITS, type CompilerResult, type Config, type Draft } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readMarkdown } from '../files/read.js';
import { normalizeVaultPath, resolveVaultDirectory, excludedName } from '../files/paths.js';
import { publishFile } from '../files/publication.js';
import { PropertyNative } from '../files/property-native.js';
import { writeSourceProperties, recoverPropertyJournal, isPropertyJournal } from '../files/properties.js';
import { compiledSourceBytes } from '../source/properties.js';
import { parseMarkdown, jsonCompatible, lifecycleStatus } from '../source/parse.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function readDraft(vault: string, relative: string): Promise<Draft> {
  if (!relative.startsWith('30_Drafts/')) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Draft path is outside its directory', 403);
  const file = await readMarkdown(vault, relative);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
    if (!match) throw new Error('properties');
    const document = parseDocument(match[1]!, { version: '1.2', schema: 'core', uniqueKeys: true, stringKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('yaml');
    const metadata = document.toJS({ maxAliasCount: LIMITS.yaml_aliases });
    if (!metadata || !jsonCompatible(metadata) || metadata.type !== 'draft' || typeof metadata.title !== 'string' || !Array.isArray(metadata.sources) || !metadata.sources.length) throw new Error('fields');
    const lifecycle = lifecycleStatus(metadata.lifecycle_status);
    if (lifecycle === null) throw new Error('lifecycle');
    const sources = metadata.sources.map((source: unknown) => {
      if (typeof source !== 'string') throw new Error('source');
      const link = /^\[\[(20_Sources\/[^\[\]#|]+)\]\]$/.exec(source);
      if (!link) throw new Error('source');
      const relative = normalizeVaultPath(/\.md$/i.test(link[1]!) ? link[1]! : `${link[1]}.md`);
      return relative;
    });
    return { path: relative, title: metadata.title, body: match[2]!, revision: file.revision, sources, lifecycle_status: lifecycle, metadata };
  } catch { throw new CoreError('INVALID_SOURCE', 'Draft Properties are invalid or unsupported', 422); }
}
export async function listDrafts(vault: string, source: string) {
  const items: Draft[] = []; const diagnostics: { code: string; message: string; path: string }[] = [];
  let candidates = 0; let total = 0;
  const visit = async (relative: string) => {
    const directory = await resolveVaultDirectory(vault, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedName(entry.name) || entry.isSymbolicLink()) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (++candidates > LIMITS.scan_candidates) throw new CoreError('PAYLOAD_TOO_LARGE', 'Draft enumeration exceeds the file limit', 413);
        try {
          const draft = await readDraft(vault, child);
          total += Buffer.byteLength(draft.body);
          if (total > LIMITS.scan_total_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'Draft enumeration exceeds the byte limit', 413);
          if (draft.sources.some(item => item.toLowerCase() === source.toLowerCase())) items.push(draft);
        } catch (error) {
          if (error instanceof CoreError && error.code === 'PAYLOAD_TOO_LARGE') throw error;
          diagnostics.push({ code: 'DRAFT_UNREADABLE', message: 'A Draft could not be read safely', path: child });
        }
      }
    }
  };
  try { await visit('30_Drafts'); }
  catch (error) { if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error; }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { items, diagnostics };
}

interface Publication { version: 1; id: string; source: string; before: string; after: string; draft: string; draft_revision: string; draft_bytes: string; route: 'api' | 'codex'; model: string; created_at: string }
const manifestPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;
export class DraftPublisher {
  private readonly directory: string;
  constructor(private readonly config: Config) { this.directory = path.join(config.data_dir, 'compiler-publications'); }
  async initialize() {
    const info = await lstat(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Publication directory is unsafe');
  }
  async prepare(id: string, source: string, before: string, result: CompilerResult, execution: { route: 'api' | 'codex'; model: string } = { route: 'codex', model: 'not recorded' }): Promise<Publication> {
    await mkdir(this.directory, { recursive: true });
    await this.initialize();
    const current = await readMarkdown(this.config.vault_path, source);
    if (current.revision !== before) throw new CoreError('SOURCE_CHANGED', 'Source changed while Compiler was running; no Draft was published', 409);
    const updated = compiledSourceBytes(source, current.bytes);
    const parsed = parseMarkdown(source, current.bytes);
    if (parsed.state !== 'ready' || parsed.processing_status !== 'pending' || parsed.lifecycle_status !== 'active') throw new CoreError('SOURCE_CHANGED', 'Source is no longer eligible for publication', 409);
    const draft = `30_Drafts/${id}.md`;
    const bytes = Buffer.from(`---\ntype: draft\ntitle: ${JSON.stringify(result.title)}\nlifecycle_status: active\nsources:\n  - ${JSON.stringify(`[[${source}]]`)}\ncompiled_source_revision: ${before}\n---\n\n# ${result.title}\n\n${result.body}\n`);
    const record: Publication = { version: 1, id, source, before, after: hash(updated), draft, draft_revision: hash(bytes), draft_bytes: bytes.toString('base64'), route: execution.route, model: execution.model, created_at: new Date().toISOString() };
    await writeFile(path.join(this.directory, `${id}.json`), JSON.stringify(record), { flag: 'wx', flush: true, mode: 0o600 });
    return record;
  }
  async finish(record: Publication): Promise<string> {
    const vault = this.config.vault_path;
    // Recover A's verified stage-write artifacts before reading an interrupted Source.
    const parent = path.posix.dirname(record.source);
    const journals = (await readdir(await resolveVaultDirectory(vault, parent))).filter(isPropertyJournal);
    if (journals.length > 100) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Source directory contains too many unfinished property writes');
    if (journals.length) {
      const native = new PropertyNative();
      try { for (const name of journals) await recoverPropertyJournal(vault, parent, name, native); }
      finally { await native.close(); }
    }
    const source = await readMarkdown(vault, record.source);
    if (![record.before, record.after].includes(source.revision)) throw new CoreError('SOURCE_CHANGED', 'Source changed; generated result was preserved for inspection', 409);
    // Only the known top-level Draft directory is created; linked directories are refused.
    await mkdir(path.join(vault, '30_Drafts')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await resolveVaultDirectory(vault, '30_Drafts');
    let existing;
    try { existing = await readMarkdown(vault, record.draft); }
    catch (error) { if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error; }
    if (existing) {
      if (existing.revision !== record.draft_revision && source.revision !== record.after) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Published Draft was edited; it remains intact and requires inspection', 409);
    } else {
      if (source.revision === record.after) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Completed Draft was moved or removed; preserve the saved result and inspect existing files', 409);
      if (!(await publishFile(vault, record.draft, Buffer.from(record.draft_bytes, 'base64')))) throw new CoreError('PATH_CONFLICT', 'Draft target already exists', 409);
    }
    if (source.revision === record.before) {
      const updated = compiledSourceBytes(record.source, source.bytes);
      if (hash(updated) !== record.after) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Source stage preconditions no longer match', 409);
      const native = new PropertyNative();
      try { await writeSourceProperties(vault, record.source, source, updated, native); }
      finally { await native.close(); }
    }
    // Successful manifests remain until startup can reconcile the Job, then become completed records.
    return record.draft;
  }
  async complete(id: string) {
    await unlink(path.join(this.directory, `${id}.json`));
  }
  async pending(): Promise<Publication[]> {
    const records: Publication[] = [];
    const names = (await readdir(this.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; })).filter(name => manifestPattern.test(name));
    if (names.length > 100) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Too many unfinished Compiler publications');
    for (const name of names) {
      const filename = path.join(this.directory, name); const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2_000_000) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Publication manifest is unsafe');
      let record: Publication;
      try { record = JSON.parse(await readFile(filename, 'utf8')); }
      catch { throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Publication manifest is invalid'); }
      if (!record || typeof record !== 'object' || Object.keys(record).sort().join(',') !== 'after,before,created_at,draft,draft_bytes,draft_revision,id,model,route,source,version') throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Publication manifest fields are invalid');
      if (record.version !== 1 || record.id !== name.slice(0, -5) || !/^20_Sources\/.+\.md$/i.test(record.source) || normalizeVaultPath(record.source) !== record.source || record.draft !== `30_Drafts/${record.id}.md`
        || !['api', 'codex'].includes(record.route) || typeof record.model !== 'string' || record.model.length > 200 || typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))
        || !/^[a-f0-9]{64}$/.test(record.before) || !/^[a-f0-9]{64}$/.test(record.after) || !/^[a-f0-9]{64}$/.test(record.draft_revision) || typeof record.draft_bytes !== 'string' || hash(Buffer.from(record.draft_bytes, 'base64')) !== record.draft_revision) throw new CoreError('COMPILATION_RECOVERY_CONFLICT', 'Publication manifest does not match its bounded Source and Draft');
      records.push(record);
    }
    return records;
  }
}
