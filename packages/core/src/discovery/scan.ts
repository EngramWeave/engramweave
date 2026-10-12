import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { LIMITS, SCAN_ROOTS, type Job, type Source } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { pathKey } from '../config.js';
import { documentPathKey, excludedName, markdownPath, normalizeVaultPath, resolveVaultDirectory, resolveMarkdown } from '../files/paths.js';
import { windowsAttributes } from '../files/windows.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown, problemDocument } from '../source/parse.js';
import { getDocument, parsedRow, publishScan, type Projection } from '../storage/registry.js';
import { indexMeta } from '../storage/database.js';
import { resolveDocumentReferences } from '../source/references.js';
import { isCaptureTemporaryName } from '../files/publication.js';
import { registeredSourceBytes } from '../source/properties.js';
import { isPropertyArtifact, isPropertyJournal, recoverPropertyJournal, writeSourceProperties } from '../files/properties.js';
import { PropertyNative } from '../files/property-native.js';
import { formalPath } from '../changesets/paths.js';

class ScanFailure extends CoreError { constructor(message: string) { super('IO_ERROR', message); } }
export interface Enumeration { paths: string[]; roots: string[]; warnings: Source['diagnostics'] }

export async function enumerateMarkdown(vault: string, knownRoots: string[], native?: PropertyNative, onBytes?: (count: number) => void, selection?: string[], roots: readonly string[] = SCAN_ROOTS): Promise<Enumeration> {
  const result: Enumeration = { paths: [], roots: [], warnings: [] };
  let recoveryEntries = 0;
  try {
    const rootInfo = await lstat(vault);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || pathKey(await realpath(vault)) !== pathKey(vault) || (await windowsAttributes([vault]))[0]?.reparse) throw new ScanFailure('Vault is unavailable or linked');
    const visit = async (relative: string) => {
      const absolute = path.join(vault, relative);
      let names = await readdir(absolute);
      const journals = names.filter(isPropertyJournal);
      recoveryEntries += journals.length;
      if (recoveryEntries > LIMITS.scan_candidates) throw new ScanFailure('Scan exceeds the property recovery entry limit');
      if (native) for (const name of journals) {
        try { await recoverPropertyJournal(vault, relative, name, native, undefined, onBytes); }
        catch (error) {
          if (error instanceof ScanFailure) throw error;
          throw new ScanFailure(`Property recovery refused at ${relative}/${name}; inspect preserved artifacts`);
        }
      }
      if (names.some(isPropertyJournal) && native) names = await readdir(absolute);
      for (const name of names.filter(isPropertyArtifact)) result.warnings.push({ code: 'PROPERTY_ARTIFACT_REMAINS', message: 'Unresolved property artifact was preserved', path: `${relative}/${name}` });
      for (const name of names.filter(isCaptureTemporaryName)) result.warnings.push({ code: 'CAPTURE_TEMPORARY_REMAINS', message: 'Capture temporary name remains; no automatic cleanup was performed', path: `${relative}/${name}` });
      const children = names.filter(name => !excludedName(name));
      const attrs = await windowsAttributes(children.map(name => path.join(absolute, name)));
      const seen = new Set<string>();
      for (const [index, name] of children.entries()) {
        if (attrs[index]?.hidden || attrs[index]?.reparse) continue;
        const key = documentPathKey(name);
        if (seen.has(key)) throw new ScanFailure('Case-folded sibling paths conflict');
        seen.add(key);
        const child = `${relative}/${name}`;
        const info = await lstat(path.join(vault, child));
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await visit(child);
        else if (info.isFile() && /\.md$/i.test(name)) {
          if (child.startsWith('60_Projects/')) formalPath(child); else markdownPath(child);
          result.paths.push(child);
          if (result.paths.length > LIMITS.scan_candidates) throw new ScanFailure('Scan exceeds the candidate count limit');
        }
      }
    };
    for (const root of roots) {
      if (![...SCAN_ROOTS, '60_Projects'].includes(root as typeof SCAN_ROOTS[number])) throw new ScanFailure('Unsupported enumeration root');
      let info;
      try { info = await lstat(path.join(vault, root)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (knownRoots.includes(root)) throw new ScanFailure('A previously indexed scan root is unavailable');
        result.warnings.push({ code: 'SCAN_ROOT_ABSENT', message: 'Scan root has never been present; treating it as empty', path: root });
        continue;
      }
      const attrs = (await windowsAttributes([path.join(vault, root)]))[0]!;
      if (!info.isDirectory() || info.isSymbolicLink() || attrs.reparse || attrs.hidden) throw new ScanFailure('Scan root is hidden, linked or unavailable');
      result.roots.push(root);
      if (!selection) await visit(root);
      else for (const requested of selection.filter(item => item === root || item.startsWith(root + '/'))) {
        const relative = normalizeVaultPath(requested);
        if (relative.split('/').some(excludedName)) continue;
        const absolute = path.join(vault, relative);
        let stat;
        try { stat = await lstat(absolute); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const attr = (await windowsAttributes([absolute]))[0]!;
        if (stat.isSymbolicLink() || attr.hidden || attr.reparse) continue;
        if (stat.isDirectory()) {
          await resolveVaultDirectory(vault, relative);
          const canonical = path.relative(vault, await realpath(absolute)).replaceAll('\\', '/').replace(/^[^/]+/, root);
          await visit(canonical);
        } else if (stat.isFile() && /\.md$/i.test(relative)) {
          // Same segment, native-attribute and ambiguity checks as a current-file read.
          try { await resolveMarkdown(vault, relative); }
          catch (error) {
            if (error instanceof CoreError && error.code === 'PATH_OUTSIDE_SCOPE' && error.details?.reason !== 'ambiguous') continue;
            throw error;
          }
          result.paths.push(path.relative(vault, await realpath(absolute)).replaceAll('\\', '/').replace(/^[^/]+/, root));
        }
      }
    }
    result.paths = [...new Set(result.paths)];
    result.paths.sort((a, b) => documentPathKey(a) < documentPathKey(b) ? -1 : documentPathKey(a) > documentPathKey(b) ? 1 : 0);
    return result;
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure('Vault scope could not be enumerated completely');
  }
}

export interface ScanSelection { paths: string[]; owners: string[]; reason: string | null }
function withinSelection(key: string, selected: Set<string>): boolean {
  while (key) {
    if (selected.has(key)) return true;
    const slash = key.lastIndexOf('/'); key = slash < 0 ? '' : key.slice(0, slash);
  }
  return false;
}
export async function scanVault(db: Database.Database, vault: string, jobId: string, mode: Job['mode'], progress: (processed: number) => void, selection?: ScanSelection): Promise<NonNullable<Job['summary']>> {
  let totalBytes = 0;
  const onBytes = (count: number) => {
    totalBytes += count;
    if (totalBytes > LIMITS.scan_total_bytes) throw new ScanFailure('Scan exceeds the cumulative read byte limit');
  };
  const native = new PropertyNative(onBytes);
  try { return await scanWithProperties(db, vault, jobId, mode, progress, native, onBytes, selection); }
  finally { await native.close(); }
}

async function scanWithProperties(db: Database.Database, vault: string, jobId: string, mode: Job['mode'], progress: (processed: number) => void, native: PropertyNative, onBytes: (count: number) => void, selection?: ScanSelection): Promise<NonNullable<Job['summary']>> {
  const previousRoots: string[] = JSON.parse(indexMeta(db).known_scan_roots);
  const partial = mode === 'refresh' && selection?.reason === null;
  const enumeration = await enumerateMarkdown(vault, previousRoots, native, onBytes, partial ? selection.paths : undefined);
  const missingPaths: string[] = [];
  if (partial) {
    const seen = new Set(enumeration.paths.map(documentPathKey));
    const selected = new Set(selection.paths.map(documentPathKey));
    const oldPaths = db.prepare("SELECT path,path_key FROM documents WHERE state!='missing'").all() as { path: string; path_key: string }[];
    for (const old of oldPaths) if (!seen.has(old.path_key) && withinSelection(old.path_key, selected)) missingPaths.push(old.path);
    const count = oldPaths.length - missingPaths.length + enumeration.paths.filter(item => !getDocument(db, item) || getDocument(db, item)?.state === 'missing').length;
    if (count > LIMITS.scan_candidates) throw new ScanFailure('Scan exceeds the candidate count limit');
  }
  const projections: Projection[] = [];
  const enumeratedPaths = new Set(enumeration.paths.map(documentPathKey));
  const absentPaths = new Set(missingPaths.map(documentPathKey));
  let readFiles = 0;
  for (const relative of enumeration.paths) {
    let projection: Projection;
    try {
      let file = await readMarkdown(vault, relative, true, onBytes);
      readFiles++;
      const previous = getDocument(db, relative);
      let parsed = mode === 'refresh' && previous?.state === 'ready' && previous.revision === file.revision
        ? parsedRow(previous) : parseMarkdown(relative, file.bytes);
      // P1 cached arbitrary lifecycle metadata; do not let the cache bypass P2 validation.
      if (parsed.state === 'ready' && parsed.lifecycle_status === null) parsed = parseMarkdown(relative, file.bytes);
      if (parsed.state === 'ready' && parsed.kind === 'source' && (parsed.processing_status === null || parsed.metadata.lifecycle_status == null || parsed.metadata.lifecycle_status === '')) {
        const updated = registeredSourceBytes(relative, file.bytes);
        await writeSourceProperties(vault, relative, file, updated, native, onBytes);
        file = await readMarkdown(vault, relative, false, onBytes);
        parsed = parseMarkdown(relative, file.bytes);
        if (parsed.state === 'ready' && parsed.processing_status === null) throw new ScanFailure('Source changed after property normalization; retry the scan');
      }
      await resolveDocumentReferences(vault, relative, parsed);
      projection = { path: relative, parsed, revision: file.revision, size: file.size, mtime: file.mtime };
    } catch (error) {
      if (error instanceof ScanFailure) throw error;
      projection = { path: relative, parsed: problemDocument(relative, error), revision: null, size: null, mtime: null };
    }
    projections.push(projection);
    progress(projections.length);
  }
  if (partial) for (const owner of selection.owners) {
    if (enumeratedPaths.has(documentPathKey(owner)) || absentPaths.has(documentPathKey(owner))) continue;
    const old = getDocument(db, owner);
    if (!old || old.state !== 'ready') continue;
    const parsed = parsedRow(old); await resolveDocumentReferences(vault, old.path, parsed);
    projections.push({ path: old.path, parsed, revision: old.revision, size: old.size, mtime: old.mtime, contentRead: false });
  }
  const warnings = [...enumeration.warnings, ...projections.flatMap(projection => projection.parsed.diagnostics)];
  return publishScan(db, jobId, projections, [...new Set([...previousRoots, ...enumeration.roots])], warnings,
    { partial, missingPaths, reason: selection?.reason ?? (mode === 'rebuild' ? 'explicit_rebuild' : null), readFiles, rebuild: mode === 'rebuild' });
}
