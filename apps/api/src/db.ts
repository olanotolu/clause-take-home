import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Schema notes
 * - `documents.seq` is the integer rowid FTS5 needs; `id` is the public identifier.
 * - Both FTS tables are EXTERNAL-CONTENT (content=documents): the text is not stored
 *   twice, and triggers keep them synchronised inside the writer's transaction, so a
 *   reader can never see content and index disagree.
 * - `revisions` holds full snapshots. Simple and makes any version restorable, but a
 *   frequently edited 10 MB document costs 10 MB per revision (see README trade-offs).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE documents (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    version      INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE revisions (
    document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    summary      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (document_id, version)
  );

  CREATE VIRTUAL TABLE documents_words USING fts5(
    title, content,
    content='documents', content_rowid='seq',
    tokenize='porter unicode61 remove_diacritics 2'
  );

  CREATE VIRTUAL TABLE documents_trgm USING fts5(
    content,
    content='documents', content_rowid='seq',
    tokenize='trigram'
  );

  CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_words(rowid, title, content) VALUES (new.seq, new.title, new.content);
    INSERT INTO documents_trgm(rowid, content) VALUES (new.seq, new.content);
  END;

  CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_words(documents_words, rowid, title, content) VALUES ('delete', old.seq, old.title, old.content);
    INSERT INTO documents_trgm(documents_trgm, rowid, content) VALUES ('delete', old.seq, old.content);
  END;

  CREATE TRIGGER documents_au AFTER UPDATE OF title, content ON documents BEGIN
    INSERT INTO documents_words(documents_words, rowid, title, content) VALUES ('delete', old.seq, old.title, old.content);
    INSERT INTO documents_trgm(documents_trgm, rowid, content) VALUES ('delete', old.seq, old.content);
    INSERT INTO documents_words(rowid, title, content) VALUES (new.seq, new.title, new.content);
    INSERT INTO documents_trgm(rowid, content) VALUES (new.seq, new.content);
  END;
  `,
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Runs `fn` in a write transaction (BEGIN IMMEDIATE: take the write lock up front). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
