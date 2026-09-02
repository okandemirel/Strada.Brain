import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UnityProjectVault } from "./unity-project-vault.js";
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from "../test-helpers.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Audit 2026-09-02: the in-memory edge cache was invalidated only by
// reindexFileInternal's success/failure paths. deleteIndexedFileInternal —
// reached by the watcher's unlink, by sync()'s prune loop and by fullIndex —
// dropped the file's edges from SQLite but left them in the cache, so
// findCallers kept naming a deleted file as a live caller (and PPR kept
// walking its edges) until some unrelated file happened to change.

const CALLER = "src/caller.ts";
const CALLEE = "src/callee.ts";
const CALLEE_SYM = `typescript::${CALLEE}::helper`;

describe("UnityProjectVault — edge cache is invalidated when an indexed file is deleted", () => {
  const tmp = createTempDirTracker("strada-vault-edge-cache-");
  const vaults: UnityProjectVault[] = [];

  function setup(): { root: string; vault: UnityProjectVault } {
    const root = tmp.makeDir();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, CALLER), "import { helper } from './callee.js';\nexport function runIt() { return helper(); }\n");
    writeFileSync(join(root, CALLEE), "export function helper() { return 1; }\n");
    const vault = new UnityProjectVault({
      id: "edge-cache", rootPath: root, embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore({ semantic: false }),
    });
    vaults.push(vault);
    return { root, vault };
  }

  afterEach(async () => {
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
  });

  it("sync() prune: a deleted caller is no longer reported by findCallers", async () => {
    const { root, vault } = setup();
    await vault.init();
    // Prime the cache through the public API (PPR reads the same cache).
    await vault.query({ text: "helper", focusFiles: [CALLER] });
    expect((await vault.findCallers(CALLEE_SYM)).some((e) => e.fromSymbol.startsWith(`typescript::${CALLER}::`))).toBe(true);

    rmSync(join(root, CALLER));
    expect((await vault.sync()).changed).toBe(1);

    const after = await vault.findCallers(CALLEE_SYM);
    expect(after.filter((e) => e.fromSymbol.startsWith(`typescript::${CALLER}::`))).toEqual([]);
  });

  it("reindexFile on a vanished path (the watcher's unlink route) invalidates too", async () => {
    const { root, vault } = setup();
    await vault.init();
    await vault.query({ text: "helper", focusFiles: [CALLER] });

    rmSync(join(root, CALLER));
    expect(await vault.reindexFile(CALLER)).toBe(true);

    const after = await vault.findCallers(CALLEE_SYM);
    expect(after.filter((e) => e.fromSymbol.startsWith(`typescript::${CALLER}::`))).toEqual([]);
  });
});
