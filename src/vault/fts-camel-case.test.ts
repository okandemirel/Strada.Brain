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
import { compoundVariants, escapeFtsQuery } from "./fts-query.js";
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
    // The obvious version of this test — open twice and assert the search
    // still works — passes with the version guard deleted, because a rebuild
    // that runs every time also produces a working index. It has to detect the
    // rebuild itself.
    //
    // So: let the first open stamp the version, then break the FTS row by hand.
    // A second open that rebuilds would repair it; one that correctly skips
    // leaves it broken. Asserting the BROKEN state is what makes this test able
    // to fail.
    const dbPath = join(dir, "index.db");
    const first = new SqliteVaultStore(dbPath);
    first.migrate();
    first.upsertFile(FILE);
    first.upsertChunk(CHUNK);
    first.close();

    const raw = new Database(dbPath);
    expect(
      (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBeGreaterThan(0);
    raw.prepare("DELETE FROM vault_chunks_fts").run();
    raw.close();

    const second = new SqliteVaultStore(dbPath);
    second.migrate();
    // Still empty => migrate() did not re-run the rebuild. If the guard is
    // removed this returns ["c1"] and the test fails, which is the point.
    expect(second.searchFts("update buff", 10)).toEqual([]);
    second.close();
  });
});

// ---------------------------------------------------------------------------
// Plan 6.7 (audit 05.cap / D44): the split family measured 0.1028 nDCG@10 with
// 22 of 60 queries returning nothing relevant, because "Update Buff" matches
// every chunk that merely says "update" or "buff" — everywhere, in real code.
// ---------------------------------------------------------------------------
describe("compound identifiers in the MATCH expression (plan 6.7)", () => {
  it("offers the concatenation adjacent words could spell, longest runs included", () => {
    expect(compoundVariants(["Update", "Buff"])).toEqual(["UpdateBuff"]);
    expect(compoundVariants(["update", "buff", "duration"])).toEqual([
      "updatebuff", "updatebuffduration", "buffduration",
    ]);
    // Only identifier-shaped words: a concatenation that cannot be a symbol is noise.
    expect(compoundVariants(["update", "42%"])).toEqual([]);
    expect(compoundVariants(["single"])).toEqual([]);
  });

  it("keeps every loose term and adds the compound, so recall never drops", () => {
    const expression = escapeFtsQuery("Update Buff");
    expect(expression).toContain('"Update"');
    expect(expression).toContain('"Buff"');
    expect(expression).toContain('"UpdateBuff"');
    expect(expression).toContain('OR "Update Buff"');
  });

  it("ranks the definition first for a human-typed identifier, against a noisy index", async () => {
    const { mkdtempSync: mk, rmSync: rm } = await import("node:fs");
    const noisyDir = mk(join(tmpdir(), "fts-compound-"));
    const noisy = new SqliteVaultStore(join(noisyDir, "index.db"));
    try {
      noisy.migrate();
      noisy.upsertFile(FILE);
      noisy.upsertChunk(CHUNK);
      // Twenty chunks that each say "update" or "buff" without defining the symbol:
      // under a bare OR of the two words these outrank the definition.
      for (let i = 0; i < 20; i++) {
        const path = `Assets/Scripts/Noise${i}.cs`;
        noisy.upsertFile({ ...FILE, path, blobHash: `h${i}` });
        noisy.upsertChunk({
          chunkId: `n${i}`, path, startLine: 1, endLine: 3, tokenCount: 20,
          // BOTH words, many times: under a bare OR of the two, term frequency
          // puts these above the one chunk that actually defines UpdateBuff.
          content: "// update the buff, update the buff timer, buff update pending, "
            + "update buff cooldown, buff update queue, update the buff stack",
        });
      }
      const ranked = noisy.searchFts(escapeFtsQuery("Update Buff"), 10).map((h) => h.chunkId);
      expect(ranked[0]).toBe("c1");
      // Guard: the exact spelling still finds it, and the loose words still match.
      expect(noisy.searchFts(escapeFtsQuery("UpdateBuff"), 10).map((h) => h.chunkId)[0]).toBe("c1");
      expect(noisy.searchFts(escapeFtsQuery("update"), 10).length).toBeGreaterThan(1);
    } finally {
      noisy.close();
      rm(noisyDir, { recursive: true, force: true });
    }
  });
});
