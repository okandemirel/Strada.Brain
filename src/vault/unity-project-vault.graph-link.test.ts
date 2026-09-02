import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UnityProjectVault } from "./unity-project-vault.js";
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from "../test-helpers.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Audit 2026-09-02: the call/import graph never had a resolved target, so
// `findCallers` on a real symbol id always fell through to the name-tail
// heuristic and PPR could not move mass off the focus files. These tests use
// the real TypeScript extractor, the real store and the real PPR.

const CALLER = "src/a_caller.ts";
const CALLEE = "src/b_callee.ts";
const DISTRACTOR = "src/c_distractor.ts";
const CALLEE_SYM = `typescript::${CALLEE}::helper`;

const CALLER_SRC = [
  "import { helper } from './b_callee.js';",
  "export function runIt() { return helper(); }",
  "",
].join("\n");
const CALLEE_SRC = "export function helper() { return 'zebraNeedle'; }\n";
// Two mentions of the needle so BM25 alone ranks the distractor above the callee.
const DISTRACTOR_SRC = "export function other() { return 'zebraNeedle zebraNeedle'; }\n";

describe("UnityProjectVault — call/import graph links to real symbols", () => {
  const tmp = createTempDirTracker("strada-vault-graph-link-");
  const vaults: UnityProjectVault[] = [];

  function makeVault(root: string): UnityProjectVault {
    const vault = new UnityProjectVault({
      id: "graph-link", rootPath: root, embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore({ semantic: false }),
    });
    vaults.push(vault);
    return vault;
  }
  function writeSrc(root: string, rel: string, body: string) {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, rel), body);
  }

  afterEach(async () => {
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
  });

  it("findCallers on the callee's real id returns the caller's call AND import edges, targeted at that id", async () => {
    const root = tmp.makeDir();
    writeSrc(root, CALLER, CALLER_SRC);
    writeSrc(root, CALLEE, CALLEE_SRC);
    const vault = makeVault(root);
    await vault.init();

    const callers = await vault.findCallers(CALLEE_SYM);
    expect(callers.map((e) => e.kind).sort()).toEqual(["calls", "imports"]);
    // Only a resolved lookup can say this; the name-tail fallback reports
    // 'typescript::unresolved::helper' and never an import edge.
    expect(callers.every((e) => e.toSymbol === CALLEE_SYM)).toBe(true);
  });

  it("links in either indexing order: caller first, callee added later by the watcher path", async () => {
    const root = tmp.makeDir();
    writeSrc(root, CALLER, CALLER_SRC);
    const vault = makeVault(root);
    await vault.init();
    expect((await vault.findCallers(CALLEE_SYM)).every((e) => e.toSymbol !== CALLEE_SYM)).toBe(true);

    writeSrc(root, CALLEE, CALLEE_SRC);
    expect(await vault.reindexFile(CALLEE)).toBe(true);
    const callers = await vault.findCallers(CALLEE_SYM);
    expect(callers.length).toBe(2);
    expect(callers.every((e) => e.toSymbol === CALLEE_SYM)).toBe(true);
  });

  it("focusFiles PPR lifts the callee above a lexically stronger unrelated file", async () => {
    const root = tmp.makeDir();
    writeSrc(root, CALLER, CALLER_SRC);
    writeSrc(root, CALLEE, CALLEE_SRC);
    writeSrc(root, DISTRACTOR, DISTRACTOR_SRC);
    const vault = makeVault(root);
    await vault.init();

    const plain = await vault.query({ text: "zebraNeedle", topK: 10 });
    const plainPaths = plain.hits.map((h) => h.chunk.path);
    expect(plainPaths).toContain(CALLEE);
    expect(plainPaths).toContain(DISTRACTOR);
    // Sanity: without focus the distractor wins on BM25 (it holds the needle twice).
    expect(plainPaths.indexOf(DISTRACTOR)).toBeLessThan(plainPaths.indexOf(CALLEE));

    const focused = await vault.query({ text: "zebraNeedle", topK: 10, focusFiles: [CALLER] });
    const paths = focused.hits.map((h) => h.chunk.path);
    // The callee is reachable from the focus file over the call graph; the
    // distractor is not. Before the link step no file outside the focus set
    // could receive any PPR mass, so this ordering was impossible.
    expect(paths.indexOf(CALLEE)).toBeLessThan(paths.indexOf(DISTRACTOR));
  });

  it("deleting the callee reverts the caller's edge to unresolved instead of claiming a dead symbol", async () => {
    const root = tmp.makeDir();
    writeSrc(root, CALLER, CALLER_SRC);
    writeSrc(root, CALLEE, CALLEE_SRC);
    const vault = makeVault(root);
    await vault.init();
    expect((await vault.findCallers(CALLEE_SYM)).some((e) => e.toSymbol === CALLEE_SYM)).toBe(true);

    rmSync(join(root, CALLEE));
    await vault.sync();
    const after = await vault.findCallers(CALLEE_SYM);
    expect(after.every((e) => e.toSymbol === "typescript::unresolved::helper")).toBe(true);
  });
});
