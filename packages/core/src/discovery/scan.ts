import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { LIMITS, SCAN_ROOTS, type Job, type Source } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { pathKey } from '../config.js';
import { documentPathKey, excludedName, markdownPath } from '../files/paths.js';
import { windowsAttributes } from '../files/windows.js';
import { readMarkdown } from '../files/read.js';
import { parseMarkdown, problemDocument } from '../source/parse.js';
import { getDocument, parsedRow, publishScan, type Projection } from '../storage/registry.js';
import { indexMeta } from '../storage/database.js';
import { resolveDocumentReferences } from '../source/references.js';
import { isCaptureTemporaryName } from '../files/publication.js';
import { pendingSourceBytes } from '../source/properties.js';
import { isPropertyArtifact, isPropertyJournal, recoverPropertyJournal, writeSourceProperties } from '../files/properties.js';
import { PropertyNative } from '../files/property-native.js';

class ScanFailure extends CoreError { constructor(message: string) { super('IO_ERROR', message); } }
export interface Enumeration { paths: string[]; roots: string[]; warnings: Source['diagnostics'] }

export async function enumerateMarkdown(vault: string, knownRoots: string[], native?: PropertyNative, onBytes?: (count: number) => void): Promise<Enumeration> {
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
          markdownPath(child);
          result.paths.push(child);
          if (result.paths.length > LIMITS.scan_candidates) throw new ScanFailure('Scan exceeds the candidate count limit');
        }
      }
    };
    for (const root of SCAN_ROOTS) {
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
      await visit(root);
    }
    result.paths.sort((a, b) => documentPathKey(a) < documentPathKey(b) ? -1 : documentPathKey(a) > documentPathKey(b) ? 1 : 0);
    return result;
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure('Vault scope could not be enumerated completely');
  }
}

export async function scanVault(db: Database.Database, vault: string, jobId: string, mode: Job['mode'], progress: (processed: number) => void): Promise<NonNullable<Job['summary']>> {
  let totalBytes = 0;
  const onBytes = (count: number) => {
    totalBytes += count;
    if (totalBytes > LIMITS.scan_total_bytes) throw new ScanFailure('Scan exceeds the cumulative read byte limit');
  };
  const native = new PropertyNative(onBytes);
  try { return await scanWithProperties(db, vault, jobId, mode, progress, native, onBytes); }
  finally { await native.close(); }
}

async function scanWithProperties(db: Database.Database, vault: string, jobId: string, mode: Job['mode'], progress: (processed: number) => void, native: PropertyNative, onBytes: (count: number) => void): Promise<NonNullable<Job['summary']>> {
  const previousRoots: string[] = JSON.parse(indexMeta(db).known_scan_roots);
  const enumeration = await enumerateMarkdown(vault, previousRoots, native, onBytes);
  const projections: Projection[] = [];
  for (const relative of enumeration.paths) {
    let projection: Projection;
    try {
      let file = await readMarkdown(vault, relative, true, onBytes);
      const previous = getDocument(db, relative);
      let parsed = mode === 'refresh' && previous?.state === 'ready' && previous.revision === file.revision
        ? parsedRow(previous) : parseMarkdown(relative, file.bytes);
      // P1 cached arbitrary lifecycle metadata; do not let the cache bypass P2 validation.
      if (parsed.state === 'ready' && parsed.lifecycle_status === null) parsed = parseMarkdown(relative, file.bytes);
      if (parsed.state === 'ready' && parsed.kind === 'source' && parsed.processing_status === null) {
        const updated = pendingSourceBytes(relative, file.bytes);
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
  const warnings = [...enumeration.warnings, ...projections.flatMap(projection => projection.parsed.diagnostics)];
  return publishScan(db, jobId, projections, [...new Set([...previousRoots, ...enumeration.roots])], warnings);
}
