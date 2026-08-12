/**
 * Vector persistence format tests.
 *
 * The raw vectors used to be serialised into metadata.json by
 * `JSON.stringify(metadata, null, 2)`. At the default 1536 dimensions that is
 * 37.8 KiB of pretty-printed decimals per vector, so the metadata string
 * crosses V8's maximum string length in the low five figures — 13,000 vectors
 * measurably throws `RangeError: Invalid string length`, while the index is
 * configured to hold 100,000. Past that point saveIndex() threw and the index
 * never persisted at all.
 *
 * Vectors now go to a binary sidecar. What matters is that (a) the round trip
 * is exact, (b) stores written by the old build still load, and (c) the JSON no
 * longer grows with vector data.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHNSWVectorStore, isHnswAvailable, type HNSWVectorStore } from "./hnsw-vector-store.js";
import type { VectorEntry, CodeChunk } from "../rag.interface.js";

const describeIfHnsw = isHnswAvailable() ? describe : describe.skip;

const DIMENSIONS = 64;
const SIDECAR = "vectors.f64";

function chunk(id: string): CodeChunk {
  return {
    id,
    filePath: `/test/${id}.cs`,
    content: `class ${id} {}`,
    startLine: 1,
    endLine: 1,
    kind: "class",
    contentHash: `hash-${id}`,
    indexedAt: 1_700_000_000_000,
    language: "csharp",
  };
}

/** Deterministic and irrational-looking, so the values survive neither float32
 *  narrowing nor accidental rounding unnoticed. */
function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => Math.sin(seed * 31 + i * 7) / 3);
}

function entry(id: string, seed: number): VectorEntry {
  return { id, vector: vector(seed), chunk: chunk(id) };
}

/**
 * The stored vectors are exactly what persistence is responsible for, and the
 * store exposes no accessor for them — the query path only ever sees the
 * index's own float32 copy, which would hide precision loss. Read the map
 * directly rather than widening the production API for a test.
 *
 * Note these are the *normalized* vectors (cosine metric), not the inputs, so
 * assertions compare a snapshot taken before saving against what comes back.
 */
type StoreInternals = {
  idToIndex: Map<string, number>;
  vectorsByIndex: Map<number, number[]>;
};

function storedVector(store: HNSWVectorStore, id: string): number[] | undefined {
  const internals = store as unknown as StoreInternals;
  const index = internals.idToIndex.get(id);
  return index === undefined ? undefined : internals.vectorsByIndex.get(index);
}

function snapshot(store: HNSWVectorStore, ids: string[]): Record<string, number[] | undefined> {
  return Object.fromEntries(ids.map((id) => [id, storedVector(store, id)]));
}

/** The old inline format, as the previous build wrote it. */
function inlineVectorsFor(store: HNSWVectorStore): [number, number[]][] {
  return [...(store as unknown as StoreInternals).vectorsByIndex.entries()];
}

describeIfHnsw("HNSW vector persistence", () => {
  let dir: string;

  const open = (): Promise<HNSWVectorStore> =>
    createHNSWVectorStore(dir, {
      dimensions: DIMENSIONS,
      maxElements: 500,
      M: 8,
      efConstruction: 50,
      efSearch: 32,
      metric: "cosine",
      quantization: "none",
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hnsw-persist-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps vector data out of metadata.json", async () => {
    const store = await open();
    await store.upsertBatch(Array.from({ length: 40 }, (_, i) => entry(`c${i}`, i + 1)));
    await store.saveIndex(dir);
    await store.shutdown();

    const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf-8"));
    expect(metadata.vectorsByIndex).toEqual([]);
    expect(existsSync(join(dir, SIDECAR))).toBe(true);

    // 12-byte header, then a uint32 index plus dimensions * 8 per entry. If
    // this drifts, the reader's length check is the thing that would break.
    expect(statSync(join(dir, SIDECAR)).size).toBe(12 + 40 * (4 + DIMENSIONS * 8));
  });

  it("round-trips vectors exactly, at full double precision", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const store = await open();
    await store.upsertBatch(ids.map((id, i) => entry(id, i + 1)));
    const before = snapshot(store, ids);
    await store.saveIndex(dir);
    await store.shutdown();

    const reopened = await open();
    expect(snapshot(reopened, ids)).toEqual(before);
    await reopened.shutdown();

    // Guard the guard: if every value happened to be float32-representable the
    // equality above would also pass under a lossy 4-byte format.
    const values = Object.values(before).flatMap((v) => v ?? []);
    expect(values.some((v) => Math.fround(v) !== v)).toBe(true);
  });

  it("still loads a store written in the old inline-JSON format", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const store = await open();
    await store.upsertBatch(ids.map((id, i) => entry(id, i + 1)));
    const before = snapshot(store, ids);
    await store.saveIndex(dir);
    const inline = inlineVectorsFor(store);
    await store.shutdown();

    // Rewrite the store the way the previous build left it: vectors inline in
    // metadata.json, no sidecar on disk.
    const metadataPath = join(dir, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.vectorsByIndex = inline;
    delete metadata.vectorsFormat;
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
    rmSync(join(dir, SIDECAR));

    const reopened = await open();
    expect(snapshot(reopened, ids)).toEqual(before);

    // Saving again migrates the old store onto the sidecar.
    await reopened.saveIndex(dir);
    expect(existsSync(join(dir, SIDECAR))).toBe(true);
    expect(JSON.parse(readFileSync(metadataPath, "utf-8")).vectorsByIndex).toEqual([]);
    await reopened.shutdown();
  });

  it("stays responsive to the event loop while building the index", async () => {
    // hnswlib's addPoint is a synchronous native call, so an unbroken add loop
    // holds the thread for the entire build — measured at 1,775 ms for 8,000
    // entries, during which no heartbeat, cancellation or channel message can
    // run. upsertBatch yields between slices to bound that.
    //
    // Asserting a millisecond bound would be flaky; this asserts the mechanism
    // instead. A timer scheduled before the batch cannot possibly fire before
    // the batch resolves unless the loop was actually yielded to.
    // Needs more entries than the shared 500-element fixture allows, and
    // enough of them to cross several yield slices.
    const store = await createHNSWVectorStore(dir, {
      dimensions: DIMENSIONS,
      maxElements: 2000,
      M: 8,
      efConstruction: 50,
      efSearch: 32,
      metric: "cosine",
      quantization: "none",
    });
    const entries = Array.from({ length: 600 }, (_, i) => entry(`c${i}`, i + 1));

    let firedDuringBuild = false;
    let finished = false;
    const ticker = setInterval(() => {
      if (!finished) firedDuringBuild = true;
    }, 1);

    await store.upsertBatch(entries);
    finished = true;
    clearInterval(ticker);
    await store.shutdown();

    expect(firedDuringBuild, "event loop ran during the index build").toBe(true);
  });

  it("falls back to metadata when the sidecar is corrupt rather than losing the vectors", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `c${i}`);
    const store = await open();
    await store.upsertBatch(ids.map((id, i) => entry(id, i + 1)));
    const before = snapshot(store, ids);
    await store.saveIndex(dir);
    const inline = inlineVectorsFor(store);
    await store.shutdown();

    // A truncated sidecar next to an old-format metadata file: the reader must
    // reject the former and fall through to the latter.
    const metadataPath = join(dir, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.vectorsByIndex = inline;
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
    writeFileSync(join(dir, SIDECAR), Buffer.from([0, 1, 2, 3]));

    const reopened = await open();
    expect(snapshot(reopened, ids)).toEqual(before);
    await reopened.shutdown();
  });
});
