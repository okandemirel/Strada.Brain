import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityProjectVault } from "./unity-project-vault.js";
import type { EmbeddingProvider, VectorStore } from "./embedding-adapter.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** In-memory VectorStore that records live ids so we can assert vector lifecycle. */
class FakeVectorStore implements VectorStore {
  private next = 0;
  readonly live = new Map<number, { vector: Float32Array; payload: unknown }>();
  add(vector: Float32Array, payload: unknown): number {
    const id = this.next++;
    this.live.set(id, { vector, payload });
    return id;
  }
  remove(id: number): void { this.live.delete(id); }
  search(): Array<{ id: number; score: number; payload?: unknown }> { return []; }
  clear(): void { this.live.clear(); }
}

class FakeEmbedding implements EmbeddingProvider {
  readonly model = "fake";
  readonly dim = 3;
  shouldFail = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.shouldFail) throw new Error("transient embed failure");
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
  }
}

describe("UnityProjectVault reindex vector lifecycle", () => {
  let dir: string;
  let store: FakeVectorStore;
  let embed: FakeEmbedding;
  let vault: UnityProjectVault;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strada-vault-test-"));
    store = new FakeVectorStore();
    embed = new FakeEmbedding();
    await writeFile(join(dir, "note.md"), "# Note\nfirst version of the note body\n", "utf8");
    vault = new UnityProjectVault({ id: "test", rootPath: dir, embedding: embed, vectorStore: store });
    await vault.init();
  });

  afterEach(async () => {
    await vault.dispose().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("throws VaultQueryError on a query that is empty after sanitization (parity with ObsidianVault)", async () => {
    await expect(vault.query({ text: "   " })).rejects.toMatchObject({
      name: "VaultQueryError",
      code: "empty_query",
    });
    // Operator/keyword-only queries also sanitize to empty.
    await expect(vault.query({ text: "AND OR NOT" })).rejects.toMatchObject({
      code: "empty_query",
    });
  });

  it("resolves a normal query without throwing", async () => {
    const result = await vault.query({ text: "note" });
    expect(Array.isArray(result.hits)).toBe(true);
  });

  it("keeps prior vectors when re-embedding fails transiently, then rebuilds on retry", async () => {
    // Initial index embedded the note → at least one live vector exists.
    const initialIds = [...store.live.keys()];
    expect(initialIds.length).toBeGreaterThan(0);

    // Change the file, then make embedding fail on the next reindex.
    await writeFile(join(dir, "note.md"), "# Note\na completely different second body\n", "utf8");
    embed.shouldFail = true;
    await vault.reindexFile("note.md");

    // Core guarantee (finding #3): a transient embed failure must NOT remove the
    // old vectors. The old ids are still live because the new embed threw before
    // any new vector was added and the old-removal only runs on success.
    for (const id of initialIds) {
      expect(store.live.has(id)).toBe(true);
    }

    // Recovery: embedding works again. Because the failed pass reset the stored
    // hash, this reindex must NOT short-circuit — it re-embeds (new id) and only
    // then removes the old vectors.
    embed.shouldFail = false;
    await vault.reindexFile("note.md");

    const finalIds = [...store.live.keys()];
    // The file is vector-searchable again: a fresh vector (id greater than any
    // initial id) was created on retry, proving the reset hash forced a
    // re-embed instead of short-circuiting — i.e. no permanent vector loss.
    expect(finalIds.some((id) => id > Math.max(...initialIds))).toBe(true);
  });
});
