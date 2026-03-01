import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IVectorStore, VectorEntry, VectorSearchHit, CodeChunk } from "./rag.interface.js";
import { denseCosineSimilarity } from "./vector-math.js";
import { getLogger } from "../utils/logger.js";

const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.bin";
const FLUSH_DEBOUNCE_MS = 5_000;

export class FileVectorStore implements IVectorStore {
  private readonly storePath: string;
  private readonly dimensions: number;

  private chunks: CodeChunk[] = [];
  private vectors: Float32Array = new Float32Array(0);

  /** chunk id → position index in chunks / vectors */
  private idIndex: Map<string, number> = new Map();
  /** filePath → set of chunk ids */
  private fileIndex: Map<string, Set<string>> = new Map();

  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(storePath: string, dimensions: number) {
    this.storePath = storePath;
    this.dimensions = dimensions;
  }

  // ---------------------------------------------------------------------------
  // IVectorStore — lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (!existsSync(this.storePath)) {
      mkdirSync(this.storePath, { recursive: true });
      getLogger().info("[FileVectorStore] Created store directory", { storePath: this.storePath });
      return;
    }

    const chunksPath = join(this.storePath, CHUNKS_FILE);
    const vectorsPath = join(this.storePath, VECTORS_FILE);

    if (!existsSync(chunksPath) || !existsSync(vectorsPath)) {
      getLogger().info("[FileVectorStore] No existing data found, starting empty", {
        storePath: this.storePath,
      });
      return;
    }

    try {
      const chunksRaw = readFileSync(chunksPath, "utf8");
      this.chunks = JSON.parse(chunksRaw) as CodeChunk[];

      const vectorsBuf = readFileSync(vectorsPath);
      this.vectors = new Float32Array(
        vectorsBuf.buffer,
        vectorsBuf.byteOffset,
        vectorsBuf.byteLength / 4,
      );

      this.rebuildIndexes();

      getLogger().info("[FileVectorStore] Loaded from disk", {
        storePath: this.storePath,
        count: this.chunks.length,
      });
    } catch (err) {
      getLogger().error("[FileVectorStore] Failed to load from disk, starting empty", {
        storePath: this.storePath,
        err,
      });
      this.chunks = [];
      this.vectors = new Float32Array(0);
      this.idIndex = new Map();
      this.fileIndex = new Map();
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.flush();
    }
  }

  // ---------------------------------------------------------------------------
  // IVectorStore — mutations
  // ---------------------------------------------------------------------------

  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Split into updates (existing id) and inserts (new id).
    const updates: VectorEntry[] = [];
    const inserts: VectorEntry[] = [];

    for (const entry of entries) {
      if (this.idIndex.has(entry.id)) {
        updates.push(entry);
      } else {
        inserts.push(entry);
      }
    }

    // Apply in-place updates.
    for (const entry of updates) {
      const idx = this.idIndex.get(entry.id)!;
      // Capture the old filePath before overwriting the chunk.
      const oldFilePath = this.chunks[idx]!.filePath;
      this.chunks[idx] = entry.chunk;
      this.setVector(idx, entry.vector);
      // File index: remove old filePath association if it changed.
      if (oldFilePath !== entry.chunk.filePath) {
        this.fileIndex.get(oldFilePath)?.delete(entry.id);
        this.addToFileIndex(entry.chunk.filePath, entry.id);
      }
    }

    // Append new entries.
    if (inserts.length > 0) {
      const oldCount = this.chunks.length;
      const newCount = oldCount + inserts.length;

      // Grow the Float32Array.
      const grown = new Float32Array(newCount * this.dimensions);
      grown.set(this.vectors);
      this.vectors = grown;

      for (let i = 0; i < inserts.length; i++) {
        const entry = inserts[i]!;
        const idx = oldCount + i;
        this.chunks.push(entry.chunk);
        this.setVector(idx, entry.vector);
        this.idIndex.set(entry.id, idx);
        this.addToFileIndex(entry.chunk.filePath, entry.id);
      }
    }

    this.markDirty();
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const idsToRemove = new Set(ids);
    const keepChunks: CodeChunk[] = [];
    const keepVectors = new Float32Array(
      Math.max(0, this.chunks.length - idsToRemove.size) * this.dimensions,
    );
    let writeIdx = 0;

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      if (idsToRemove.has(chunk.id)) {
        // Remove from file index.
        this.fileIndex.get(chunk.filePath)?.delete(chunk.id);
        continue;
      }
      keepChunks.push(chunk);
      keepVectors.set(
        this.vectors.subarray(i * this.dimensions, (i + 1) * this.dimensions),
        writeIdx * this.dimensions,
      );
      writeIdx++;
    }

    this.chunks = keepChunks;
    this.vectors = keepVectors;
    this.rebuildIdIndex();
    this.markDirty();
  }

  async removeByFile(filePath: string): Promise<void> {
    const ids = this.getFileChunkIds(filePath);
    if (ids.length === 0) return;
    await this.remove(ids);
  }

  // ---------------------------------------------------------------------------
  // IVectorStore — queries
  // ---------------------------------------------------------------------------

  async search(queryVector: number[], topK: number): Promise<VectorSearchHit[]> {
    const n = this.chunks.length;
    if (n === 0 || topK <= 0) return [];

    const scored: Array<{ idx: number; score: number }> = new Array(n);

    for (let i = 0; i < n; i++) {
      const storedVec = Array.from(
        this.vectors.subarray(i * this.dimensions, (i + 1) * this.dimensions),
      );
      scored[i] = { idx: i, score: denseCosineSimilarity(queryVector, storedVec) };
    }

    // Partial sort: we only need the top-K items.
    scored.sort((a, b) => b.score - a.score);

    const results: VectorSearchHit[] = [];
    const limit = Math.min(topK, n);
    for (let i = 0; i < limit; i++) {
      results.push({ chunk: this.chunks[scored[i]!.idx]!, score: scored[i]!.score });
    }
    return results;
  }

  count(): number {
    return this.chunks.length;
  }

  has(id: string): boolean {
    return this.idIndex.has(id);
  }

  getFileChunkIds(filePath: string): string[] {
    const set = this.fileIndex.get(filePath);
    return set ? Array.from(set) : [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private setVector(idx: number, vector: number[]): void {
    const offset = idx * this.dimensions;
    for (let i = 0; i < this.dimensions; i++) {
      this.vectors[offset + i] = vector[i]!;
    }
  }

  private addToFileIndex(filePath: string, id: string): void {
    let set = this.fileIndex.get(filePath);
    if (!set) {
      set = new Set();
      this.fileIndex.set(filePath, set);
    }
    set.add(id);
  }

  private rebuildIndexes(): void {
    this.idIndex = new Map();
    this.fileIndex = new Map();
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      this.idIndex.set(chunk.id, i);
      this.addToFileIndex(chunk.filePath, chunk.id);
    }
  }

  /** Rebuild only the id→index map (used after compact removes). */
  private rebuildIdIndex(): void {
    this.idIndex = new Map();
    for (let i = 0; i < this.chunks.length; i++) {
      this.idIndex.set(this.chunks[i]!.id, i);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flush(): void {
    try {
      const chunksPath = join(this.storePath, CHUNKS_FILE);
      const vectorsPath = join(this.storePath, VECTORS_FILE);

      writeFileSync(chunksPath, JSON.stringify(this.chunks), "utf8");

      const buf = Buffer.from(
        this.vectors.buffer,
        this.vectors.byteOffset,
        this.vectors.byteLength,
      );
      writeFileSync(vectorsPath, buf);

      this.dirty = false;
      getLogger().debug("[FileVectorStore] Flushed to disk", {
        storePath: this.storePath,
        count: this.chunks.length,
      });
    } catch (err) {
      getLogger().error("[FileVectorStore] Failed to flush to disk", {
        storePath: this.storePath,
        err,
      });
    }
  }
}
