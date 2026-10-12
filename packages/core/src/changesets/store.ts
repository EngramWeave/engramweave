import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, rmdir } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { ChangeSetSchema, LIMITS, type ChangeSet, type ChangeSetItem, type CandidateDocument, type CandidateSave, type Config } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { readVaultFile, type FileRead } from '../files/read.js';
import { resolveVaultDirectory, resolveVaultFile, normalizeVaultPath } from '../files/paths.js';
import { PropertyNative } from '../files/property-native.js';
import { writeCandidateFile, recoverPropertyJournal, isPropertyJournal } from '../files/properties.js';
import { publishFile } from '../files/publication.js';
import { changeSetFile, changeSetId, formalPath } from './paths.js';
import { parseMarkdownContent } from '../source/parse.js';
import { resolveDocumentReferences } from '../source/references.js';

const absent = (error: unknown) => error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND';
export class ChangeSets {
  private readonly writing = new Set<string>();
  constructor(readonly config: Config) {}
  private manifestPath(id: string) { return `70_ChangeSets/${changeSetId(id)}/manifest.json`; }
  private async exclusive<T>(id: string, action: () => Promise<T>) {
    changeSetId(id);
    if (this.writing.has(id)) throw new CoreError('JOB_BUSY', 'ChangeSet is being saved', 409);
    this.writing.add(id); try { return await action(); } finally { this.writing.delete(id); }
  }
  private async recover(relative: string, native: PropertyNative) {
    const parent = path.posix.dirname(relative); const directory = await resolveVaultDirectory(this.config.vault_path, parent);
    const names = (await readdir(directory)).filter(isPropertyJournal);
    if (names.length > 100) throw new CoreError('PATH_CONFLICT', 'Too many unresolved candidate writes', 409);
    for (const name of names) await recoverPropertyJournal(this.config.vault_path, parent, name, native);
  }
  private async file(relative: string, native?: PropertyNative): Promise<FileRead> {
    changeSetFile(relative);
    if (native) await this.recover(relative, native);
    return readVaultFile(this.config.vault_path, relative);
  }
  private async write(relative: string, content: string, before: string | null, native: PropertyNative) {
    changeSetFile(relative); const bytes = Buffer.from(content);
    if (bytes.length > LIMITS.markdown_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'Candidate exceeds Markdown size bound', 413);
    await native.ensureTaskDirectory(this.config.vault_path, path.posix.dirname(relative));
    let file: FileRead | null;
    try { file = await this.file(relative, native); } catch (error) { if (!absent(error)) throw error; file = null; }
    if (file?.revision !== before && !(file === null && before === null)) throw new CoreError('SOURCE_CHANGED', 'Candidate changed; preserve edits and reload its current revision', 409);
    if (file) return writeCandidateFile(this.config.vault_path, relative, file, bytes, native);
    if (!await publishFile(this.config.vault_path, relative, bytes)) throw new CoreError('PATH_CONFLICT', 'Candidate appeared during creation', 409);
    return this.file(relative);
  }
  async create(input: Omit<ChangeSet, 'version' | 'id' | 'created_at' | 'state' | 'items'>) {
    const manifest: ChangeSet = { version: 1, id: randomUUID(), created_at: new Date().toISOString(), state: 'preparing', ...input, items: [] };
    this.validate(manifest); const native = new PropertyNative();
    try { await this.write(this.manifestPath(manifest.id), JSON.stringify(manifest), null, native); } finally { await native.close(); }
    return manifest;
  }
  private validate(manifest: ChangeSet) {
    if (!Value.Check(ChangeSetSchema, manifest)) throw new CoreError('VALIDATION_ERROR', 'Invalid ChangeSet manifest', 400);
    normalizeVaultPath(manifest.source_path); normalizeVaultPath(manifest.draft_path);
    if (!/^20_Sources\/.+\.md$/i.test(manifest.source_path) || !/^30_Drafts\/.+\.md$/i.test(manifest.draft_path)) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Invalid ChangeSet input', 403);
    const ids = new Set<string>(); const targets = new Set<string>();
    for (const item of manifest.items) {
      formalPath(item.target, item.kind === 'directory');
      if (ids.has(item.id) || targets.has(item.target.toLowerCase())) throw new CoreError('PATH_CONFLICT', 'Duplicate or case-conflicting ChangeSet target', 409);
      ids.add(item.id); targets.add(item.target.toLowerCase());
      const candidate = item.kind === 'write' ? `70_ChangeSets/${manifest.id}/candidates/${item.target}` : null;
      if (item.candidate_path !== candidate || item.kind !== 'write' && item.candidate_path !== null) throw new CoreError('PATH_OUTSIDE_SCOPE', 'Candidate must mirror its assigned target', 403);
      for (const evidence of item.evidence) { normalizeVaultPath(evidence.path); if (evidence.end_line < evidence.start_line) throw new CoreError('VALIDATION_ERROR', 'Invalid evidence range', 400); }
    }
  }
  async read(id: string) {
    const native = new PropertyNative(); let file: FileRead;
    try { file = await this.file(this.manifestPath(id), native); } finally { await native.close(); }
    let manifest: ChangeSet;
    try { manifest = JSON.parse(file.bytes.toString('utf8')); } catch { throw new CoreError('VALIDATION_ERROR', 'Unreadable ChangeSet manifest', 422); }
    this.validate(manifest);
    if (manifest.id !== id) throw new CoreError('PATH_CONFLICT', 'ChangeSet identity does not match its directory', 409);
    return { manifest, revision: file.revision };
  }
  async list(source?: string) {
    let names: string[];
    try { names = await readdir(await resolveVaultDirectory(this.config.vault_path, '70_ChangeSets')); }
    catch (error) { if (!absent(error)) throw error; return []; }
    if (names.length > LIMITS.scan_candidates) throw new CoreError('PAYLOAD_TOO_LARGE', 'Too many ChangeSet directories', 413);
    const items: ChangeSet[] = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      let manifest: ChangeSet;
      try { manifest = (await this.read(name)).manifest; } catch (error) { if (absent(error)) continue; throw error; }
      if (manifest.state === 'ready' && (!source || source.toLowerCase() === manifest.source_path.toLowerCase())) items.push(manifest);
    }
    return items.sort((a,b) => a.created_at.localeCompare(b.created_at));
  }
  /** Detect missing candidate files without rereading mutable formal targets or rejecting human edits. */
  async verifyCandidates(id:string){
    const {manifest}=await this.read(id);const native=new PropertyNative();
    try{for(const item of manifest.items)if(item.candidate_path)await this.file(item.candidate_path,native);}finally{await native.close();}
  }
  async propose(id: string, input: Omit<ChangeSetItem, 'id' | 'candidate_path'>, content?: string, expected?: string) {
    return this.exclusive(id, async () => {
      const { manifest, revision } = await this.read(id);
      if (manifest.state !== 'preparing') throw new CoreError('PATH_CONFLICT', 'Agent cannot edit a published ChangeSet', 409);
      formalPath(input.target, input.kind === 'directory');
      const prior = manifest.items.find(item => item.target.toLowerCase() === input.target.toLowerCase());
      if (prior && (prior.target !== input.target || prior.kind !== input.kind)) throw new CoreError('PATH_CONFLICT', 'Target conflicts with an existing proposal', 409);
      const item: ChangeSetItem = { ...input, id: prior?.id ?? randomUUID(), candidate_path: input.kind === 'write' ? `70_ChangeSets/${id}/candidates/${input.target}` : null };
      manifest.items = [...manifest.items.filter(entry => entry.id !== item.id), item]; this.validate(manifest);
      const native = new PropertyNative();
      try {
        if (item.candidate_path) {
          if (content === undefined || !content.trim()) throw new CoreError('VALIDATION_ERROR', 'File proposal needs nonempty final Markdown', 400);
          if (prior && !expected) throw new CoreError('SOURCE_CHANGED', 'Editing a candidate requires its current revision', 409);
          await this.write(item.candidate_path, content, expected ?? null, native);
        }
        await this.write(this.manifestPath(id), JSON.stringify(manifest), revision, native);
      } finally { await native.close(); }
      return item;
    });
  }
  async candidate(id: string, itemId: string): Promise<CandidateDocument> {
    const { manifest } = await this.read(id); const item = manifest.items.find(item => item.id === itemId);
    if (!item?.candidate_path) throw new CoreError('DOCUMENT_NOT_FOUND', 'No editable candidate for this item', 404);
    const native = new PropertyNative(); let file: FileRead;
    try { file = await this.file(item.candidate_path, native); } finally { await native.close(); }
    let current: FileRead | null;
    try { current = await readVaultFile(this.config.vault_path, formalPath(item.target)); } catch (error) { if (!absent(error)) throw error; current = null; }
    return { changeset_id: id, item, current: current ? new TextDecoder('utf-8', { fatal: true }).decode(current.bytes) : null, current_revision: current?.revision ?? null,
      content: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), revision: file.revision };
  }
  async save(input: CandidateSave) {
    return this.exclusive(input.changeset_id, async () => {
      const { manifest } = await this.read(input.changeset_id); const item = manifest.items.find(item => item.id === input.item_id);
      if (manifest.state !== 'ready' || !item?.candidate_path) throw new CoreError('PATH_CONFLICT', 'Only published file candidates can be saved', 409);
      const native = new PropertyNative();
      try {
        const current = await this.file(item.candidate_path, native);
        // A lost-response retry is safe only when the requested bytes are already current.
        if (current.bytes.equals(Buffer.from(input.content))) return { revision: current.revision };
        const next = await this.write(item.candidate_path, input.content, input.revision, native); return { revision: next.revision };
      } finally { await native.close(); }
    });
  }
  private async validateContent(manifest:ChangeSet){
    if (!manifest.items.some(item => item.kind === 'write')) throw new CoreError('INVALID_MODEL_OUTPUT', 'Integration requires final content, not only source retention or structure', 422);
    let size = 0;
    for (const item of manifest.items) if (item.candidate_path) {
      const candidate = await this.candidate(manifest.id, item.id); size += Buffer.byteLength(candidate.content);
      const parsed=parseMarkdownContent(formalPath(item.target),Buffer.from(candidate.content));
      const references=await resolveDocumentReferences(this.config.vault_path,item.target,parsed);
      if (!parsed.body_markdown.trim() || parsed.state!=='ready' || !references.some(ref=>ref.target_path?.toLowerCase()===manifest.source_path.toLowerCase())) throw new CoreError('INVALID_MODEL_OUTPUT', 'Candidate must be valid Markdown with its Source Record link in sources Properties', 422);
      let parent=path.posix.dirname(item.target);
      while(parent.includes('/')){
        try{await resolveVaultDirectory(this.config.vault_path,parent);}
        catch(error){if(!absent(error))throw error;if(!manifest.items.some(entry=>entry.kind==='directory'&&entry.target===parent))throw new CoreError('INVALID_MODEL_OUTPUT', `Missing directory proposal: ${parent}`,422);}
        parent=path.posix.dirname(parent);
      }
    }
    if (size > LIMITS.scan_total_bytes) throw new CoreError('PAYLOAD_TOO_LARGE', 'ChangeSet exceeds the content budget', 413);
  }
  async inspect(id:string){
    const {manifest}=await this.read(id);
    try{await this.validateContent(manifest);return{items:manifest.items,valid:true,diagnostics:[],formal_files_applied:false};}
    catch(error){
      if(!(error instanceof CoreError)||!['INVALID_MODEL_OUTPUT','PAYLOAD_TOO_LARGE','DOCUMENT_NOT_FOUND'].includes(error.code))throw error;
      return{items:manifest.items,valid:false,diagnostics:[{code:error.code,message:error.message}],formal_files_applied:false};
    }
  }
  async publish(id: string) {
    return this.exclusive(id, async () => {
      const { manifest, revision } = await this.read(id);
      await this.validateContent(manifest);
      if (manifest.state === 'ready') return manifest;
      manifest.state = 'ready'; const native = new PropertyNative();
      try { await this.write(this.manifestPath(id), JSON.stringify(manifest), revision, native); } finally { await native.close(); }
      return manifest;
    });
  }
  /** Called only for explicit human cancellation; the Agent capability never exposes it. */
  async cancel(id: string) {
    return this.exclusive(id, async () => {
      await this.read(id); const relative = `70_ChangeSets/${id}`; const files: string[] = []; const directories: string[] = [];
      const visit = async (directory: string) => {
        const resolved = await resolveVaultDirectory(this.config.vault_path, directory); directories.push(directory);
        const recovery=new PropertyNative();
        try{for(const name of(await readdir(resolved)).filter(isPropertyJournal))await recoverPropertyJournal(this.config.vault_path,directory,name,recovery);}finally{await recovery.close();}
        for (const name of await readdir(resolved)) {
          const child = `${directory}/${name}`; const info = await lstat(path.join(resolved, name));
          if (info.isDirectory()) await visit(child);
          else { changeSetFile(child); await resolveVaultFile(this.config.vault_path, child); files.push(child); }
        }
      };
      await visit(relative); const native = new PropertyNative();
      try { for (const file of files) { const value = await this.file(file, native); await native.removeCandidate(this.config.vault_path, file, value.revision); } }
      finally { await native.close(); }
      for (const directory of directories.reverse()) await rmdir(await resolveVaultDirectory(this.config.vault_path, directory));
    });
  }
}
