import type Database from 'better-sqlite3';
/** Exact shipped P1/P2-B document constraint; retain data while constructing a legacy fixture. */
export function legacyDatabase(db: Database.Database, version: 1 | 2 | 3) {
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='documents'").get() as { sql: string }).sql;
  db.exec('ALTER TABLE documents RENAME TO current_documents');
  db.exec(version === 3 ? ddl : ddl.replace("CHECK(kind IN ('source','knowledge','idea','research'))", "CHECK(kind IN ('source','knowledge'))"));
  db.exec('INSERT INTO documents SELECT * FROM current_documents; DROP TABLE current_documents;');
  if (version === 1) db.exec('DROP TABLE compiler_jobs');
  db.exec('DROP TABLE analyzer_jobs');
  db.prepare('UPDATE meta SET schema_version=?').run(version);
  db.pragma(`user_version=${version}`);
}
