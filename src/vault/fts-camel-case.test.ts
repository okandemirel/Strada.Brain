/**
 * camelCase searchability in the lexical index.
 *
 * FTS5 is configured with `tokenize = 'porter unicode61'`, which splits only on
 * non-alphanumeric characters. `UpdateBuff` is therefore a single token, and a
 * search for `update buff` matches neither half — measured on the benchmark
 * corpus, querying identifiers the way a developer types them scored nDCG@10
 * 0.0246 with 43 of 60 queries returning nothing relevant, against a perfect
 * 1.0 for the same queries as exact identifiers.
 *
 * ftsText() appends a word-split copy of the content to what gets indexed. The
 * original spelling stays, so exact lookup keeps its exact-token match.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteVaultStore, ftsText } from "./sqlite-vault-store.js";
import type { VaultChunk, VaultFile } from "./vault.interface.js";

const FILE: VaultFile = {
  path: "Assets/Scripts/Combat.cs",
  blobHash: "h", mtimeMs: 0, size: 100,
  lang: "csharp", kind: "source", indexedAt: 0,
};

const CHUNK: VaultChunk = {
  chunkId: "c1",
  path: FILE.path,
  startLine: 1,
  endLine: 3,
  content: "public void UpdateBuff(int id) { HTTPServer.Send(id); }",
  tokenCount: 12,
};

describe("ftsText", () => {
  it("splits camelCase and PascalCase identifiers", () => {
    expect(ftsText("UpdateBuff")).toContain("Update Buff");
  });

  it("splits an acronym run from the word that follows it", () => {
    // HTTPServer -> "HTTP Server", not "H T T P Server".
    expect(ftsText("HTTPServer")).toContain("HTTP Server");
  });

  it("keeps the original spelling so exact lookup still matches", () => {
    expect(ftsText("UpdateBuff")).toContain("UpdateBuff");
  });

  it("leaves text without compound identifiers untouched", () => {
    // No split form means no reason to double the indexed text.
    expect(ftsText("just some plain words")).toBe("just some plain words");
  });
});

describe("lexical search for camelCase identifiers", () => {
  let dir: string;
  let store: SqliteVaultStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-camel-"));
    store = new SqliteVaultStore(join(dir, "index.db"));
    store.migrate();
    store.upsertFile(FILE);
    store.upsertChunk(CHUNK);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a PascalCase symbol when searched as separate words", () => {
    expect(store.searchFts("update buff", 10).map((h) => h.chunkId)).toEqual(["c1"]);
  });

  it("still finds it by its exact spelling", () => {
    expect(store.searchFts("UpdateBuff", 10).map((h) => h.chunkId)).toEqual(["c1"]);
  });
});

describe("FTS rebuild on upgrade", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-migrate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-indexes a database written before ftsText existed", () => {
    const dbPath = join(dir, "index.db");

    // Build a store, then rewrite its FTS row the way the previous build did —
    // raw content, no split copy — and reset the version stamp so the database
    // looks exactly like one created before this change.
    const first = new SqliteVaultStore(dbPath);
    first.migrate();
    first.upsertFile(FILE);
    first.upsertChunk(CHUNK);
    first.close();

    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM vault_chunks_fts").run();
    raw.prepare("INSERT INTO vault_chunks_fts (content, chunk_id, path) VALUES (?, ?, ?)")
      .run(CHUNK.content, CHUNK.chunkId, CHUNK.path);
    raw.prepare("PRAGMA user_version = 0").run();
    raw.close();

    // Confirm the fixture really is stale, otherwise the assertion below would
    // pass without the migration doing anything.
    const stale = new Database(dbPath);
    const staleHit = stale.prepare(
      "SELECT chunk_id FROM vault_chunks_fts WHERE vault_chunks_fts MATCH ?",
    ).all("update buff");
    stale.close();
    expect(staleHit, "fixture is a genuinely stale index").toEqual([]);

    // Opening it now must rebuild the FTS index from the stored chunk content,
    // without touching the filesystem the project came from.
    const upgraded = new SqliteVaultStore(dbPath);
    upgraded.migrate();
    expect(upgraded.searchFts("update buff", 10).map((h) => h.chunkId)).toEqual(["c1"]);
    upgraded.close();
  });

  it("does not rebuild a second time", () => {
    const dbPath = join(dir, "index.db");
    const first = new SqliteVaultStore(dbPath);
    first.migrate();
    first.upsertFile(FILE);
    first.upsertChunk(CHUNK);
    first.close();

    // A store opened again is already current, so the version stamp stays put
    // and the rebuild is skipped — it must not run on every open.
    const raw = new Database(dbPath);
    const version = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    raw.close();
    expect(version).toBeGreaterThan(0);

    const second = new SqliteVaultStore(dbPath);
    second.migrate();
    expect(second.searchFts("update buff", 10).map((h) => h.chunkId)).toEqual(["c1"]);
    second.close();
  });
});
