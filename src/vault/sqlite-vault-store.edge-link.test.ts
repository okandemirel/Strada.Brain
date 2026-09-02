import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteVaultStore, unresolvedTailName } from "./sqlite-vault-store.js";
import type { VaultChunk, VaultFile, VaultSymbol, VaultEdge } from "./vault.interface.js";

// Audit 2026-09-02: every edge the extractors emit targets
// '<lang>::unresolved::<name>', and nothing ever linked those targets to the
// symbols that carry the name. findCallersOf(realId) could never match and
// PPR mass could never leave the focus files. These tests pin the link rule:
// exactly one indexed symbol with that name wins, ambiguity/absence stays
// unresolved, and the link survives either indexing order and a delete.

const CALLER: VaultFile = { path: "src/caller.ts", blobHash: "h1", mtimeMs: 1, size: 1, lang: "typescript", kind: "source", indexedAt: 1 };
const CALLEE: VaultFile = { path: "src/callee.ts", blobHash: "h2", mtimeMs: 1, size: 1, lang: "typescript", kind: "source", indexedAt: 1 };
const TWIN: VaultFile = { path: "src/twin.ts", blobHash: "h3", mtimeMs: 1, size: 1, lang: "typescript", kind: "source", indexedAt: 1 };

const CALLER_SYM = "typescript::src/caller.ts::runIt";
const CALLEE_SYM = "typescript::src/callee.ts::helper";
const TWIN_SYM = "typescript::src/twin.ts::helper";
const RAW_TARGET = "typescript::unresolved::helper";

function sym(symbolId: string, path: string, name: string): VaultSymbol {
  return { symbolId, path, kind: "function", name, display: name, startLine: 1, endLine: 3, doc: null };
}
function chunk(path: string): VaultChunk {
  return { chunkId: `${path}#1`, path, startLine: 1, endLine: 3, content: `body of ${path}`, tokenCount: 3 };
}
function txn(store: SqliteVaultStore, file: VaultFile, symbols: VaultSymbol[], edges: VaultEdge[]) {
  const r = store.runReindexTxn({
    path: file.path, file, chunks: [chunk(file.path)], symbols, edges, wikilinks: [], frontmatter: null, tags: null,
  });
  expect(r.ok).toBe(true);
}
function indexCaller(store: SqliteVaultStore) {
  txn(store, CALLER, [sym(CALLER_SYM, CALLER.path, "runIt")], [
    { fromSymbol: CALLER_SYM, toSymbol: RAW_TARGET, kind: "calls", atLine: 2 },
  ]);
}
function indexCallee(store: SqliteVaultStore) {
  txn(store, CALLEE, [sym(CALLEE_SYM, CALLEE.path, "helper")], []);
}
function indexTwin(store: SqliteVaultStore) {
  txn(store, TWIN, [sym(TWIN_SYM, TWIN.path, "helper")], []);
}

describe("SqliteVaultStore — unresolved edge targets link to the one symbol carrying the name", () => {
  let dir: string;
  let store: SqliteVaultStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-edge-link-"));
    store = new SqliteVaultStore(join(dir, "db.sqlite"));
    store.migrate();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links when the callee is indexed AFTER the caller (incoming link)", () => {
    indexCaller(store);
    expect(store.findCallersOf(CALLEE_SYM)).toEqual([]);
    indexCallee(store);
    const callers = store.findCallersOf(CALLEE_SYM);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({ fromSymbol: CALLER_SYM, toSymbol: CALLEE_SYM, kind: "calls" });
    expect(store.listEdges().map((e) => e.toSymbol)).toEqual([CALLEE_SYM]);
  });

  it("links when the callee is indexed BEFORE the caller (outgoing link)", () => {
    indexCallee(store);
    indexCaller(store);
    expect(store.findCallersOf(CALLEE_SYM)).toHaveLength(1);
    expect(store.listEdges().map((e) => e.toSymbol)).toEqual([CALLEE_SYM]);
  });

  it("leaves the target unresolved while two symbols carry the name, and links once one goes away", () => {
    indexCallee(store);
    indexCaller(store);
    indexTwin(store); // second `helper` → ambiguous → nothing is invented
    expect(store.findCallersOf(CALLEE_SYM)).toEqual([]);
    expect(store.findCallersOf(TWIN_SYM)).toEqual([]);
    expect(store.listEdges().map((e) => e.toSymbol)).toEqual([RAW_TARGET]);

    store.deleteFile(TWIN.path); // back to exactly one → links to the survivor
    expect(store.findCallersOf(CALLEE_SYM)).toHaveLength(1);
  });

  it("deleting the callee keeps the caller's edge, reverted to its raw unresolved target", () => {
    indexCallee(store);
    indexCaller(store);
    store.deleteFile(CALLEE.path);
    expect(store.findCallersOf(CALLEE_SYM)).toEqual([]);
    expect(store.listEdges()).toEqual([
      { fromSymbol: CALLER_SYM, toSymbol: RAW_TARGET, kind: "calls", atLine: 2 },
    ]);
    indexCallee(store); // re-appears → relinked without touching the caller
    expect(store.findCallersOf(CALLEE_SYM)).toHaveLength(1);
  });

  it("re-indexing the callee with a renamed symbol unlinks the old target and links the new one", () => {
    indexCallee(store);
    indexCaller(store);
    txn(store, CALLEE, [sym("typescript::src/callee.ts::helperV2", CALLEE.path, "helperV2")], []);
    expect(store.findCallersOf(CALLEE_SYM)).toEqual([]);
    expect(store.listEdges().map((e) => e.toSymbol)).toEqual([RAW_TARGET]);
  });

  it("an import edge with a '#name' tail links to the named symbol, a bare module import does not", () => {
    indexCallee(store);
    txn(store, CALLER, [sym("typescript::src/caller.ts::<module>", CALLER.path, "<module>")], [
      { fromSymbol: "typescript::src/caller.ts::<module>", toSymbol: "typescript::unresolved::./callee.js#helper", kind: "imports", atLine: 1 },
      { fromSymbol: "typescript::src/caller.ts::<module>", toSymbol: "typescript::unresolved::./side-effect.js", kind: "imports", atLine: 2 },
    ]);
    const targets = store.listEdges().map((e) => e.toSymbol).sort();
    expect(targets).toEqual([CALLEE_SYM, "typescript::unresolved::./side-effect.js"]);
  });

  it("migrate() backfills the link on a database indexed before the columns existed", () => {
    store.close();
    // Build the pre-audit schema by hand: same DDL minus the two derived columns.
    const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8")
      .replace(/--[^\n]*/g, "")
      .replace(/\n\s*to_name\s+TEXT,/, "")
      .replace(/\n\s*resolved_to\s+TEXT,/, "");
    const legacyPath = join(dir, "legacy.sqlite");
    const raw = new Database(legacyPath);
    raw.pragma("foreign_keys = ON");
    for (const stmt of schema.split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter(Boolean)) raw.prepare(stmt).run();
    const cols = (raw.prepare("PRAGMA table_info(vault_edges)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("resolved_to");
    raw.prepare("INSERT INTO vault_files VALUES (?,?,?,?,?,?,?)").run(CALLER.path, "h", 1, 1, "typescript", "source", 1);
    raw.prepare("INSERT INTO vault_files VALUES (?,?,?,?,?,?,?)").run(CALLEE.path, "h", 1, 1, "typescript", "source", 1);
    raw.prepare("INSERT INTO vault_symbols VALUES (?,?,?,?,?,?,?,?)").run(CALLER_SYM, CALLER.path, "function", "runIt", "runIt", 1, 3, null);
    raw.prepare("INSERT INTO vault_symbols VALUES (?,?,?,?,?,?,?,?)").run(CALLEE_SYM, CALLEE.path, "function", "helper", "helper", 1, 3, null);
    raw.prepare("INSERT INTO vault_edges (from_symbol, to_symbol, kind, at_line) VALUES (?,?,?,?)").run(CALLER_SYM, RAW_TARGET, "calls", 2);
    raw.close();

    store = new SqliteVaultStore(legacyPath);
    store.migrate();
    expect(store.findCallersOf(CALLEE_SYM)).toHaveLength(1);
    expect(store.listEdges().map((e) => e.toSymbol)).toEqual([CALLEE_SYM]);
  });
});

describe("unresolvedTailName", () => {
  it("extracts the bare identifier the linker may match on", () => {
    expect(unresolvedTailName("typescript::unresolved::helper")).toBe("helper");
    expect(unresolvedTailName("csharp::unresolved::TakeDamage")).toBe("TakeDamage");
    expect(unresolvedTailName("typescript::unresolved::./a.js#helper")).toBe("helper");
    expect(unresolvedTailName("csharp::unresolved::UnityEngine.UI")).toBe("UI");
  });
  it("refuses anything that is not a plain identifier", () => {
    expect(unresolvedTailName("typescript::unresolved::./a.js")).toBeNull();      // bare module path
    expect(unresolvedTailName("typescript::unresolved::node:fs")).toBeNull();
    expect(unresolvedTailName("csharp::unresolved::IFoo<T>")).toBeNull();          // generic
    expect(unresolvedTailName("csharp::unresolved::<anon>")).toBeNull();
    expect(unresolvedTailName("typescript::src/a.ts::helper")).toBeNull();         // already a symbol id
  });
});
