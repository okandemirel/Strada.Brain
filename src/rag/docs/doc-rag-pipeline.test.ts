/**
 * MEM-12: DocRAG recorded a file's hash before embedding it and never removed
 * chunks, so an embedding failure was never retried, a shrunk document kept
 * its old sections, and a package upgrade (the chunk ids embed the version)
 * left every older version's docs next to the new ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocRAGPipeline } from "./doc-rag-pipeline.js";
import type { IEmbeddingProvider, IVectorStore, VectorEntry } from "../rag.interface.js";
import type { PackageRoot } from "./doc-rag.interface.js";

function memoryStore(): IVectorStore & { entries: Map<string, VectorEntry> } {
  const entries = new Map<string, VectorEntry>();
  return {
    entries,
    initialize: async () => {},
    shutdown: async () => {},
    upsert: async (list) => { for (const e of list) entries.set(e.id, e as VectorEntry); },
    remove: async (ids) => { for (const id of ids) entries.delete(id); },
    removeByFile: async (filePath) => {
      for (const [id, e] of entries) if (e.chunk.filePath === filePath) entries.delete(id);
    },
    search: async () => [],
    count: () => entries.size,
    has: (id) => entries.has(id),
    getFileChunkIds: (filePath) => [...entries].filter(([, e]) => e.chunk.filePath === filePath).map(([id]) => id),
    listIndexedFiles: () => [...new Set([...entries.values()].map((e) => e.chunk.filePath as string))].map((filePath) => ({ filePath })),
  };
}

function embedder(failures = 0): IEmbeddingProvider {
  let remaining = failures;
  return {
    name: "fake",
    dimensions: 4,
    embed: async (texts: string[]) => {
      if (remaining > 0) {
        remaining--;
        throw new Error("provider down");
      }
      return { embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]) } as never;
    },
  };
}

const readme = (sections: number): string =>
  Array.from({ length: sections }, (_, i) => `# Section ${i}\n\nBody of section ${i}.\n`).join("\n");

describe("DocRAGPipeline keeps the doc store in step with the sources (MEM-12)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docrag-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops the previous version's chunks after an upgrade", async () => {
    writeFileSync(join(dir, "README.md"), readme(3));
    const store = memoryStore();
    const pipeline = new DocRAGPipeline(embedder(), store);
    await pipeline.indexPackage({ name: "strada.core", path: dir, version: "1.0.0" });
    const v1 = [...store.entries.keys()];
    expect(v1.length).toBeGreaterThan(0);

    // Same text, new version: the ids change, so the old ones must go.
    await pipeline.indexPackage({ name: "strada.core", path: dir, version: "1.1.0" });

    const versions = new Set([...store.entries.values()].map((e) => (e.chunk as { packageVersion?: string }).packageVersion));
    expect(versions).toEqual(new Set(["1.1.0"]));
    for (const id of v1) expect(store.entries.has(id)).toBe(false);
  });

  it("removes the sections a shrunk document lost", async () => {
    const pkg: PackageRoot = { name: "strada.core", path: dir, version: "1.0.0" };
    writeFileSync(join(dir, "README.md"), readme(5));
    const store = memoryStore();
    const pipeline = new DocRAGPipeline(embedder(), store);
    await pipeline.indexPackage(pkg);
    const before = store.entries.size;

    writeFileSync(join(dir, "README.md"), readme(2));
    await pipeline.indexPackage(pkg);
    expect(store.entries.size).toBeLessThan(before);
    expect(store.entries.size).toBe(2);
  });

  it("retries a file whose embedding failed", async () => {
    const pkg: PackageRoot = { name: "strada.core", path: dir, version: "1.0.0" };
    writeFileSync(join(dir, "README.md"), readme(2));
    const store = memoryStore();
    const pipeline = new DocRAGPipeline(embedder(1), store);

    await pipeline.indexPackage(pkg);
    expect(store.entries.size).toBe(0);
    await pipeline.indexPackage(pkg);
    expect(store.entries.size).toBe(2);
  });

  it("forgets the chunks of a file that was deleted", async () => {
    const pkg: PackageRoot = { name: "strada.core", path: dir, version: "1.0.0" };
    writeFileSync(join(dir, "README.md"), readme(1));
    writeFileSync(join(dir, "GUIDE.md"), readme(2));
    const store = memoryStore();
    const pipeline = new DocRAGPipeline(embedder(), store);
    await pipeline.indexPackage(pkg);

    rmSync(join(dir, "GUIDE.md"));
    await pipeline.indexPackage(pkg);
    expect([...store.entries.values()].every((e) => e.chunk.filePath.endsWith("README.md"))).toBe(true);
  });
});
