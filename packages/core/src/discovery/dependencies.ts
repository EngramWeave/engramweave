import path from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeVaultPath } from '../files/paths.js';
import { stringList } from '../source/parse.js';

/** Disposable reverse dependency hints; actual availability is resolved through safe current paths. */
export class ReferenceDependencies {
  private targets = new Map<string, Set<string>>();
  rebuild(db: Database.Database) {
    this.targets.clear();
    const rows = db.prepare("SELECT path,kind,metadata_json,original_locator FROM documents WHERE state='ready'").all() as { path: string; kind: string; metadata_json: string; original_locator: string | null }[];
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json);
      const raw = row.kind === 'source' ? [row.original_locator, typeof metadata.asset === 'string' ? metadata.asset : null] : stringList(metadata.sources);
      for (const value of raw) {
        if (typeof value !== 'string') continue;
        const link = /^\[\[([^\[\]\r\n]+)\]\]$/.exec(value); if (!link) continue;
        const locator = link[1]!.split('|')[0]!.split('#')[0]!.trim();
        try {
          const relative = normalizeVaultPath(locator.startsWith('./') || locator.startsWith('../') ? path.posix.normalize(path.posix.join(path.posix.dirname(row.path), locator)) : locator);
          const candidates = row.kind !== 'source' && !/\.md$/i.test(relative) ? [relative, relative + '.md'] : [relative];
          for (const target of candidates) {
            const key = target.toLowerCase(); const owners = this.targets.get(key) ?? new Set<string>(); owners.add(row.path); this.targets.set(key, owners);
          }
        } catch { /* Invalid/outside references never authorize a filesystem operation. */ }
      }
    }
  }
  affected(paths: string[]) {
    const result = new Set<string>();
    const changed = new Set(paths.map(relative => relative.toLowerCase()));
    if (!changed.size) return [];
    for (const [target, owners] of this.targets) {
      let key = target;
      while (key) {
        if (changed.has(key)) { for (const owner of owners) result.add(owner); break; }
        const slash = key.lastIndexOf('/'); key = slash < 0 ? '' : key.slice(0, slash);
      }
    }
    return [...result];
  }
}
