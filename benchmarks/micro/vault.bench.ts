/**
 * Vault micro-benchmarks.
 *
 * Hermetic by construction: reads the pinned synthetic corpus, writes to a
 * temp SQLite file, never touches the network or an embedding provider. That
 * matters because the semantic half of retrieval sits behind availability
 * switches — a benchmark that silently fell back to BM25-only would report
 * fast, green numbers while measuring something else entirely. Everything here
 * measures the LEXICAL path explicitly, and says so in its name.
 *
 * Run: npm run bench   (corpus first: npm run bench:corpus)
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chunkFile } from "../../src/vault/chunker.js";
import { SqliteVaultStore } from "../../src/vault/sqlite-vault-store.js";
import { createLogger } from "../../src/utils/logger.js";
import type { VaultChunk, VaultFile } from "../../src/vault/vault.interface.js";

const CORPUS = resolve(import.meta.dirname, "..", "corpus", "unity-synth-v1-s");

interface SourceFile { path: string; content: string; lang: VaultFile["lang"] }

function loadCorpus(): SourceFile[] {
  if (!existsSync(CORPUS)) {
    throw new Error(
      `Benchmark corpus missing at ${CORPUS}. Run: npm run bench:corpus`,
    );
  }
  const out: SourceFile[] = [];
  const scripts = join(CORPUS, "Assets", "Scripts");
  for (const name of readdirSync(scripts)) {
    out.push({ path: `Assets/Scripts/${name}`, content: readFileSync(join(scripts, name), "utf8"), lang: "csharp" });
  }
  const docs = join(CORPUS, "Docs");
  for (const name of readdirSync(docs)) {
    out.push({ path: `Docs/${name}`, content: readFileSync(join(docs, name), "utf8"), lang: "markdown" });
  }
  return out;
}

function fileRow(file: SourceFile): VaultFile {
  return {
    path: file.path, blobHash: file.path, mtimeMs: 0,
    size: file.content.length, lang: file.lang,
    kind: file.lang === "markdown" ? "doc" : "source", indexedAt: 0,
  };
}

let corpus: SourceFile[] = [];
let chunked: Array<{ file: SourceFile; chunks: VaultChunk[] }> = [];
let readDir: string;
let readStore: SqliteVaultStore;

// One top-level setup: nested per-describe hooks do not reliably run in
// vitest's benchmark mode, which silently produced zero samples for the
// SQLite group.
beforeAll(() => {
  createLogger("error", "bench.log");
  corpus = loadCorpus();
  chunked = corpus.map((file) => ({ file, chunks: chunkFile(file) }));

  readDir = mkdtempSync(join(tmpdir(), "strada-bench-idx-"));
  readStore = new SqliteVaultStore(join(readDir, "index.db"));
  readStore.migrate();
  for (const { file, chunks } of chunked) {
    readStore.upsertFile(fileRow(file));
    for (const c of chunks) readStore.upsertChunk(c);
  }
});

afterAll(() => {
  readStore?.close();
  if (readDir) rmSync(readDir, { recursive: true, force: true });
});

describe("vault.chunker", () => {
  bench("chunk the whole corpus", () => {
    for (const file of corpus) chunkFile(file);
  });
});

describe("vault.sqlite.write", () => {
  bench("index the corpus into a fresh DB", () => {
    const d = mkdtempSync(join(tmpdir(), "strada-bench-w-"));
    const s = new SqliteVaultStore(join(d, "index.db"));
    try {
      s.migrate();
      for (const { file, chunks } of chunked) {
        s.upsertFile(fileRow(file));
        for (const c of chunks) s.upsertChunk(c);
      }
    } finally {
      s.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("vault.query.bm25", () => {
  bench("single-term FTS", () => {
    readStore.searchFts('"damping"', 20);
  });

  bench("multi-term FTS (natural-language shape)", () => {
    readStore.searchFts('("inventory" OR "damping" OR "player") OR "inventory damping player"', 20);
  });
});
