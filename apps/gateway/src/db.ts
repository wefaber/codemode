import { Database } from 'bun:sqlite'

/** The gateway's own state: catalog, tokens, audit rows (SPEC §9) and the budgets: result bytes per day, calls per minute. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      product    TEXT PRIMARY KEY,
      major      INTEGER NOT NULL,
      version    TEXT NOT NULL,
      url        TEXT NOT NULL,
      spec       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      scopes     TEXT NOT NULL,
      expires_at INTEGER,
      revoked    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id        TEXT PRIMARY KEY,
      products      TEXT NOT NULL,
      token_hash    TEXT NOT NULL,
      agent_label   TEXT,
      kind          TEXT NOT NULL,
      ops           TEXT NOT NULL,
      calls         INTEGER NOT NULL,
      ms            INTEGER NOT NULL,
      result_bytes  INTEGER NOT NULL,
      truncated     INTEGER NOT NULL,
      error_code    TEXT,
      spec_versions TEXT NOT NULL,
      via           TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_token_time ON runs (token_hash, created_at);
    CREATE TABLE IF NOT EXISTS usage (
      token_hash TEXT NOT NULL,
      day        TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      PRIMARY KEY (token_hash, day)
    );
    CREATE TABLE IF NOT EXISTS call_usage (
      token_hash TEXT NOT NULL,
      minute     INTEGER NOT NULL,
      calls      INTEGER NOT NULL,
      PRIMARY KEY (token_hash, minute)
    );
  `)
  return db
}
