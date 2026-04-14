-- WARNING: applyDdl in sqlite-vault-store.ts splits this file by `;\s*(?=\n|$)`.
-- Do NOT include semicolons inside quoted string literals or multi-line comments —
-- they will silently break the statement parser. Use a literal '\u003B' if needed.

CREATE TABLE IF NOT EXISTS vault_files (
  path        TEXT PRIMARY KEY,
  blob_hash   TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  lang        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL,
  merkle_dir  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vault_chunks (
  chunk_id    TEXT PRIMARY KEY,
  path        TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON vault_chunks(path);

CREATE VIRTUAL TABLE IF NOT EXISTS vault_chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  path UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS vault_embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES vault_chunks(chunk_id) ON DELETE CASCADE,
  hnsw_id    INTEGER NOT NULL,
  dim        INTEGER NOT NULL,
  model      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_symbols (
  symbol_id   TEXT PRIMARY KEY,
  path        TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  display     TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  doc         TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_path ON vault_symbols(path);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON vault_symbols(name);

CREATE TABLE IF NOT EXISTS vault_edges (
  from_symbol TEXT NOT NULL REFERENCES vault_symbols(symbol_id) ON DELETE CASCADE,
  to_symbol   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  at_line     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_symbol, to_symbol, kind, at_line)
);

CREATE INDEX IF NOT EXISTS idx_edges_to ON vault_edges(to_symbol);

CREATE TABLE IF NOT EXISTS vault_wikilinks (
  from_note   TEXT NOT NULL,
  target      TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_note, target)
);

CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON vault_wikilinks(target);

INSERT INTO vault_meta(key, value) VALUES ('indexer_version', 'phase2.v1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
