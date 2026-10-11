import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { moveAsideCorruptFileSync, writeFileAtomicSync } from "../common/atomic-file.js";
import type { IVectorStore, VectorEntry, VectorSearchHit, CodeChunk } from "./rag.interface.js";
import { collectIndexedFiles } from "./rag.interface.js";
import { getLogger } from "../utils/logger.js";

const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.bin";
/**
 * Written after chunks.json and vectors.bin, holding a hash of each: the pair
 * is saved as two files, and a crash between them used to leave every chunk
 * silently paired with another chunk's vector (MEM-13). A mismatch on load
 * means the two came from different saves.
 */
const MANIFEST_FILE = "store-manifest.json";

interface StoreManifest {
  version: 1;
  count: number;
  dimensions: number;
  chunksSha256: string;
  vectorsSha256: string;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
const FLUSH_DEBOUNCE_MS = 5_000;
const HNSW_M = 16; // Number of bi-directional links for each element
const HNSW_EF_CONSTRUCTION = 200; // Size of dynamic list for nearest neighbors
const HNSW_EF_SEARCH = 100; // Size of dynamic list for search
/**
 * Up to this many stored floats (chunks x dimensions) a search scans every
 * vector: about 20 ms at the limit (~11k chunks at 1536 dims). Building the JS
 * graph blocks the event loop for seconds even at 3000 chunks of 768 dims, and
 * every boot used to pay for it. The graph is built only past this size, by
 * the first search that needs it.
 */
const EXACT_SCAN_MAX_FLOATS = 1 << 24;

/**
 * HNSW (Hierarchical Navigable Small World) index node
 */
interface HNSWNode {
  id: string;
  vector: Float32Array;
  level: number;
  connections: Map<number, Set<number>>; // level -> indices of connected nodes
  /** Removed: still walked through, never returned or linked to. */
  deleted: boolean;
}

/** `v` scaled to length 1 (a zero vector stays zero), as a new array. */
function unitVector(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  const out = new Float32Array(v);
  if (norm === 0) return out;
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) out[i]! *= scale;
  return out;
}

/** Cosine similarity of two unit vectors. */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Inserts `item` into `list`, which is kept in ascending score order. */
function insertByScore(
  list: Array<{ idx: number; score: number }>,
  item: { idx: number; score: number },
): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.score < item.score) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

/**
 * SIMD-accelerated vector operations using Float32Array
 */
class VectorOps {
  /**
   * Fast cosine similarity using Float32Array operations
   * Optimized for V8 JIT compilation
   */
  static cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
    const len = a.length;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    // Unrolled loop for better performance
    const remainder = len % 4;
    const blocks = len - remainder;
    
    for (let i = 0; i < blocks; i += 4) {
      const a0 = a[i]!, a1 = a[i + 1]!, a2 = a[i + 2]!, a3 = a[i + 3]!;
      const b0 = b[i]!, b1 = b[i + 1]!, b2 = b[i + 2]!, b3 = b[i + 3]!;
      
      dotProduct += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
      normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
      normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
    }
    
    // Handle remaining elements
    for (let i = blocks; i < len; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dotProduct += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Batch cosine similarity computation for multiple vectors
   * Much faster than individual calls
   */
  static batchCosineSimilarity(
    query: Float32Array | number[],
    vectors: Float32Array[],
    topK: number
  ): Array<{ idx: number; score: number }> {
    const scores: Array<{ idx: number; score: number }> = new Array(vectors.length);
    
    for (let i = 0; i < vectors.length; i++) {
      scores[i] = { idx: i, score: this.cosineSimilarity(query, vectors[i]!) };
    }
    
    // Partial quickselect for topK
    return this.partialSort(scores, topK);
  }

  /**
   * Partial sort using quickselect-like algorithm
   * O(n) average case instead of O(n log n) full sort
   */
  private static partialSort(
    arr: Array<{ idx: number; score: number }>,
    k: number
  ): Array<{ idx: number; score: number }> {
    // Asked for all of them, the caller still expects them best first.
    if (k >= arr.length) return arr.sort((a, b) => b.score - a.score);

    // Simple heap-based selection for small k
    if (k <= 50) {
      return this.heapSelect(arr, k);
    }
    
    // Full sort for larger k (more efficient)
    arr.sort((a, b) => b.score - a.score);
    return arr.slice(0, k);
  }

  /**
   * Min-heap based selection for small k values
   */
  private static heapSelect(
    arr: Array<{ idx: number; score: number }>,
    k: number
  ): Array<{ idx: number; score: number }> {
    const heap: Array<{ idx: number; score: number }> = [];
    
    for (const item of arr) {
      if (heap.length < k) {
        heap.push(item);
        this.heapifyUp(heap, heap.length - 1);
      } else if (item.score > heap[0]!.score) {
        heap[0] = item;
        this.heapifyDown(heap, 0, k);
      }
    }
    
    return heap.sort((a, b) => b.score - a.score);
  }

  private static heapifyUp(heap: Array<{ idx: number; score: number }>, i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      const parentItem = heap[parent];
      const currentItem = heap[i];
      if (!parentItem || !currentItem || parentItem.score <= currentItem.score) break;
      heap[parent] = currentItem;
      heap[i] = parentItem;
      i = parent;
    }
  }

  private static heapifyDown(
    heap: Array<{ idx: number; score: number }>,
    i: number,
    size: number
  ): void {
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      const currentItem = heap[i];
      
      if (left < size) {
        const leftItem = heap[left];
        if (leftItem && currentItem && leftItem.score < currentItem.score) smallest = left;
      }
      if (right < size) {
        const rightItem = heap[right];
        const smallestItem = heap[smallest];
        if (rightItem && smallestItem && rightItem.score < smallestItem.score) smallest = right;
      }
      
      if (smallest === i) break;
      const smallestItem = heap[smallest];
      if (currentItem && smallestItem) {
        heap[i] = smallestItem;
        heap[smallest] = currentItem;
      }
      i = smallest;
    }
  }
}

/**
 * HNSW (Hierarchical Navigable Small World) Index
 * Provides approximate nearest neighbor search with O(log n) complexity
 */
class HNSWIndex {
  private nodes: HNSWNode[] = [];
  private idToIndex: Map<string, number> = new Map();
  private entryPoint: number = -1;
  private maxLevel: number = 0;
  private deletedCount = 0;
  private readonly m: number;
  private readonly efConstruction: number;
  private readonly efSearch: number;

  constructor(_dimensions: number, m = HNSW_M, efConstruction = HNSW_EF_CONSTRUCTION, efSearch = HNSW_EF_SEARCH) {
    this.m = m;
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
  }

  /**
   * Get random level for new node (exponential distribution)
   */
  private randomLevel(): number {
    let level = 0;
    const mult = 1 / Math.log(this.m);
    while (Math.random() < Math.exp(-1 / mult) && level < 16) {
      level++;
    }
    return level;
  }

  /**
   * Add a vector to the index
   */
  add(id: string, vector: Float32Array): void {
    if (this.idToIndex.has(id)) {
      // Update existing
      this.update(id, vector);
      return;
    }

    const level = this.randomLevel();
    // Stored at unit length, so every comparison below is a plain dot product.
    const unit = unitVector(vector);
    const node: HNSWNode = {
      id,
      vector: unit,
      level,
      connections: new Map(),
      deleted: false,
    };

    const newIndex = this.nodes.length;
    this.nodes.push(node);
    this.idToIndex.set(id, newIndex);

    if (this.nodes.length === 1) {
      this.entryPoint = 0;
      this.maxLevel = level;
      return;
    }

    // Insert into layers from top to level+1 (find entry point)
    let currEp = this.entryPoint;
    for (let l = this.maxLevel; l > level; l--) {
      currEp = this.searchLayerClosest(unit, currEp, l);
    }

    // Insert at each level from min(level, maxLevel) down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayerKNN(unit, currEp, this.efConstruction, l);
      this.connectNewNode(newIndex, neighbors, l);
      currEp = neighbors[0]?.idx ?? currEp;
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = newIndex;
    }
  }

  /**
   * Update an existing vector
   */
  update(id: string, vector: Float32Array): void {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return;
    const current = this.nodes[idx]!.vector;
    const unit = unitVector(vector);
    if (current.length === unit.length && current.every((v, i) => v === unit[i])) return;

    // The node's links were chosen for its old vector; a moved node has to be
    // linked where it now sits, or searches near it never reach it.
    this.remove(id);
    this.add(id, vector);
  }

  /**
   * Remove a vector from the index
   */
  remove(id: string): void {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return;

    // The node stays in the graph as a waypoint: dropping it cut off every
    // node that was only reached through it. Its owner discards the graph
    // once the removed nodes outnumber the live ones (see isStale).
    this.idToIndex.delete(id);
    this.nodes[idx]!.deleted = true;
    this.deletedCount++;
  }

  /** True once the removed nodes outnumber the live ones. */
  isStale(): boolean {
    return this.deletedCount > this.idToIndex.size;
  }

  /**
   * Search for k nearest neighbors
   */
  search(query: Float32Array, k: number): Array<{ id: string; score: number }> {
    if (this.idToIndex.size === 0 || this.entryPoint < 0) return [];

    const ef = Math.max(k, this.efSearch);
    const unit = unitVector(query);
    let currEp = this.entryPoint;

    // Search from top layer down to layer 1
    for (let l = this.maxLevel; l > 0; l--) {
      currEp = this.searchLayerClosest(unit, currEp, l);
    }

    // Search layer 0 with full ef
    const candidates = this.searchLayerKNN(unit, currEp, ef, 0);

    // Return top k
    return candidates.slice(0, k).map((c) => ({ id: this.nodes[c.idx]!.id, score: c.score }));
  }

  /**
   * Search layer for closest single point (greedy)
   */
  private searchLayerClosest(query: Float32Array, entryPoint: number, level: number): number {
    let curr = entryPoint;
    let currScore = dot(query, this.nodes[curr]!.vector);
    let changed = true;

    const visited = new Set<number>([curr]);

    while (changed) {
      changed = false;
      const connections = this.nodes[curr]!.connections.get(level);
      if (!connections) break;

      for (const neighbor of connections) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const score = dot(query, this.nodes[neighbor]!.vector);
        if (score > currScore) {
          curr = neighbor;
          currScore = score;
          changed = true;
        }
      }
    }

    return curr;
  }

  /**
   * Search layer for the ef nearest live neighbors, best first
   */
  private searchLayerKNN(
    query: Float32Array,
    entryPoint: number,
    ef: number,
    level: number
  ): Array<{ idx: number; score: number }> {
    const entryNode = this.nodes[entryPoint]!;
    const entry = { idx: entryPoint, score: dot(query, entryNode.vector) };
    const visited = new Set<number>([entryPoint]);
    // Both lists ascend by score: the next node to expand is the last
    // candidate, the worst kept result is the first.
    const candidates = [entry];
    const results = entryNode.deleted ? [] : [entry];

    while (candidates.length > 0) {
      const current = candidates.pop()!;
      // Nothing left to expand can improve a full result list.
      if (results.length >= ef && current.score < results[0]!.score) break;

      const connections = this.nodes[current.idx]!.connections.get(level);
      if (!connections) continue;

      for (const neighbor of connections) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const neighborNode = this.nodes[neighbor]!;
        const score = dot(query, neighborNode.vector);
        if (results.length >= ef && score <= results[0]!.score) continue;

        const item = { idx: neighbor, score };
        insertByScore(candidates, item);
        if (!neighborNode.deleted) {
          insertByScore(results, item);
          if (results.length > ef) results.shift();
        }
      }
    }

    return results.reverse();
  }

  /**
   * Connect new node to neighbors at given level
   */
  private connectNewNode(
    newIdx: number,
    neighbors: Array<{ idx: number; score: number }>,
    level: number
  ): void {
    const mMax = level === 0 ? this.m * 2 : this.m;
    const newNode = this.nodes[newIdx]!;

    const selected = this.selectNeighbors(neighbors, this.m);
    const connections = new Set<number>(selected.map(n => n.idx));
    newNode.connections.set(level, connections);

    // Add reverse connections
    for (const { idx: neighborIdx } of selected) {
      const neighbor = this.nodes[neighborIdx]!;
      let neighborConns = neighbor.connections.get(level);
      if (!neighborConns) {
        neighborConns = new Set();
        neighbor.connections.set(level, neighborConns);
      }

      neighborConns.add(newIdx);

      // Shrink if too many connections
      if (neighborConns.size > mMax) {
        this.shrinkConnections(neighborIdx, level, mMax);
      }
    }
  }

  /**
   * Shrink connections to maintain m_max limit
   */
  private shrinkConnections(nodeIdx: number, level: number, mMax: number): void {
    const node = this.nodes[nodeIdx]!;
    const conns = node.connections.get(level);
    if (!conns || conns.size <= mMax) return;

    // Choose by distance. Keeping the oldest links dropped the back-link to
    // every node added after this one filled up, so a search could reach only
    // the first few dozen nodes ever inserted.
    const ranked = [...conns]
      .map((idx) => ({ idx, score: dot(node.vector, this.nodes[idx]!.vector) }))
      .sort((a, b) => b.score - a.score);
    node.connections.set(level, new Set(this.selectNeighbors(ranked, mMax).map((r) => r.idx)));
  }

  /**
   * HNSW neighbor-selection heuristic: walking `candidates` best first, keep
   * one only if it is closer to the base node than to every one kept so far.
   * Plain nearest-m links all point into the node's own cluster, so clusters
   * end up joined by nothing and a search stays in whichever it entered.
   */
  private selectNeighbors(
    candidates: Array<{ idx: number; score: number }>,
    m: number
  ): Array<{ idx: number; score: number }> {
    if (candidates.length <= m) return candidates;
    const selected: Array<{ idx: number; score: number }> = [];
    for (const candidate of candidates) {
      if (selected.length >= m) break;
      const vector = this.nodes[candidate.idx]!.vector;
      const diverse = selected.every(
        (kept) => dot(vector, this.nodes[kept.idx]!.vector) <= candidate.score,
      );
      if (diverse) selected.push(candidate);
    }
    return selected;
  }

  /**
   * Get approximate count of valid nodes
   */
  get size(): number {
    return this.idToIndex.size;
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.nodes = [];
    this.idToIndex.clear();
    this.entryPoint = -1;
    this.maxLevel = 0;
    this.deletedCount = 0;
  }
}

/**
 * Optimized File Vector Store with HNSW indexing
 */
export class FileVectorStore implements IVectorStore {
  private readonly storePath: string;
  private readonly dimensions: number;
  private chunks: CodeChunk[] = [];
  private vectors: Float32Array = new Float32Array(0);
  /** Built on demand by search(); kept in step with the store once built, until dropStaleGraph() discards it. */
  private hnswIndex: HNSWIndex | null = null;
  private readonly exactScanMaxFloats: number;

  /** chunk id → position index in chunks / vectors */
  private idIndex: Map<string, number> = new Map();
  /** filePath → set of chunk ids */
  private fileIndex: Map<string, Set<string>> = new Map();

  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: boolean = false;

  constructor(storePath: string, dimensions: number, options: { exactScanMaxFloats?: number } = {}) {
    this.storePath = storePath;
    this.dimensions = dimensions;
    this.exactScanMaxFloats = options.exactScanMaxFloats ?? EXACT_SCAN_MAX_FLOATS;
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
      const chunksBuf = readFileSync(chunksPath);
      const vectorsBuf = readFileSync(vectorsPath);
      const chunks = JSON.parse(chunksBuf.toString("utf8")) as CodeChunk[];
      this.assertConsistentPair(chunks, chunksBuf, vectorsBuf);
      this.chunks = chunks;
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
      // Keep the unusable files for inspection rather than overwriting them
      // with the next save; the index is derived data and the next indexing
      // pass rebuilds it.
      const preserved = [chunksPath, vectorsPath, join(this.storePath, MANIFEST_FILE)]
        .filter((path) => existsSync(path))
        .map((path) => moveAsideCorruptFileSync(path) ?? `${path} (could not be moved aside)`);
      getLogger().error("[FileVectorStore] Stored index is unusable, starting empty", {
        storePath: this.storePath,
        error: err instanceof Error ? err.message : String(err),
        preserved,
      });
      this.chunks = [];
      this.vectors = new Float32Array(0);
      this.idIndex = new Map();
      this.fileIndex = new Map();
      this.hnswIndex = null;
    }
  }

  /** Throws when chunks.json and vectors.bin cannot belong to the same save. */
  private assertConsistentPair(chunks: unknown, chunksBuf: Buffer, vectorsBuf: Buffer): void {
    if (!Array.isArray(chunks)) throw new Error(`${CHUNKS_FILE} does not hold a chunk list`);
    const expectedBytes = chunks.length * this.dimensions * 4;
    if (vectorsBuf.byteLength !== expectedBytes) {
      throw new Error(
        `${VECTORS_FILE} holds ${vectorsBuf.byteLength} bytes; ${chunks.length} chunks at ${this.dimensions} dimensions need ${expectedBytes}`,
      );
    }
    const manifestPath = join(this.storePath, MANIFEST_FILE);
    // A store saved before the manifest existed only gets the size check.
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<StoreManifest>;
    if (manifest.chunksSha256 !== sha256(chunksBuf) || manifest.vectorsSha256 !== sha256(vectorsBuf)) {
      throw new Error(`${CHUNKS_FILE} and ${VECTORS_FILE} come from different saves`);
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

    // Batch process for better performance
    const batchSize = 1000;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      await this.upsertBatch(batch);
    }

    this.markDirty();
  }

  private async upsertBatch(entries: VectorEntry[]): Promise<void> {
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
      const oldFilePath = this.chunks[idx]!.filePath;
      this.chunks[idx] = entry.chunk as CodeChunk;
      this.setVector(idx, entry.vector);
      
      // Update HNSW index
      this.hnswIndex?.update(entry.id, new Float32Array(entry.vector));
      
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

      // Grow the Float32Array efficiently
      const grown = new Float32Array(newCount * this.dimensions);
      grown.set(this.vectors);
      this.vectors = grown;

      for (let i = 0; i < inserts.length; i++) {
        const entry = inserts[i]!;
        const idx = oldCount + i;
        this.chunks.push(entry.chunk as CodeChunk);
        this.setVector(idx, entry.vector);
        this.idIndex.set(entry.id, idx);
        this.addToFileIndex(entry.chunk.filePath, entry.id);
        
        // Add to HNSW index
        this.hnswIndex?.add(entry.id, new Float32Array(entry.vector));
      }
    }
    this.dropStaleGraph();
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const idsToRemove = new Set(ids);
    const keepChunks: CodeChunk[] = [];
    const keepVectors = new Float32Array(
      Math.max(0, this.chunks.length - idsToRemove.size) * this.dimensions,
    );
    let writeIdx = 0;

    // Build new index mapping
    const newIdIndex = new Map<string, number>();

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      if (idsToRemove.has(chunk.id)) {
        this.fileIndex.get(chunk.filePath)?.delete(chunk.id);
        this.hnswIndex?.remove(chunk.id);
        continue;
      }
      
      keepChunks.push(chunk);
      keepVectors.set(
        this.vectors.subarray(i * this.dimensions, (i + 1) * this.dimensions),
        writeIdx * this.dimensions,
      );
      newIdIndex.set(chunk.id, writeIdx);
      writeIdx++;
    }

    this.chunks = keepChunks;
    this.vectors = keepVectors;
    this.idIndex = newIdIndex;
    this.dropStaleGraph();
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

    const queryFloat = new Float32Array(queryVector);
    
    // Use HNSW for approximate search when a scan would be slow (see
    // EXACT_SCAN_MAX_FLOATS). A query for every chunk (a file-scoped search
    // ranks the whole store) always takes the exact scan.
    if (topK < n && n * this.dimensions > this.exactScanMaxFloats) {
      this.hnswIndex ??= this.buildHnswIndex();
      const hnswResults = this.hnswIndex.search(queryFloat, topK);
      return hnswResults.map(r => ({
        id: r.id,
        chunk: this.chunks[this.idIndex.get(r.id)!]!,
        score: r.score,
        distanceMetric: "cosine" as const,
      }));
    }

    // Exact scan
    const vectors: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      vectors.push(this.vectors.subarray(i * this.dimensions, (i + 1) * this.dimensions));
    }

    const topResults = VectorOps.batchCosineSimilarity(queryFloat, vectors, topK);
    
    return topResults.map(r => ({
      id: this.chunks[r.idx]!.id,
      chunk: this.chunks[r.idx]!,
      score: r.score,
      distanceMetric: "cosine" as const,
    }));
  }

  count(): number {
    return this.chunks.length;
  }

  has(id: string): boolean {
    return this.idIndex.has(id);
  }

  listIndexedFiles(): Array<{ filePath: string; fileContentHash?: string }> {
    return collectIndexedFiles(this.chunks);
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
    // Use TypedArray.set for efficient bulk copy
    this.vectors.set(vector, offset);
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
    this.hnswIndex = null;

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      this.idIndex.set(chunk.id, i);
      this.addToFileIndex(chunk.filePath, chunk.id);
    }
  }

  /**
   * A graph mostly made of removed nodes is discarded, and the next graph
   * search builds it from the live chunks. Rebuilding it here instead put a
   * full build inside whichever write crossed the line: one file's re-index
   * stalled the event loop for as long as a build of the whole store takes.
   */
  private dropStaleGraph(): void {
    if (this.hnswIndex?.isStale()) this.hnswIndex = null;
  }

  private buildHnswIndex(): HNSWIndex {
    const index = new HNSWIndex(this.dimensions);
    for (let i = 0; i < this.chunks.length; i++) {
      index.add(this.chunks[i]!.id, this.vectors.subarray(i * this.dimensions, (i + 1) * this.dimensions));
    }
    return index;
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.pendingFlush) return;
    
    this.pendingFlush = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }
    
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.pendingFlush = false;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flush(): void {
    try {
      const chunksPath = join(this.storePath, CHUNKS_FILE);
      const vectorsPath = join(this.storePath, VECTORS_FILE);

      const chunksBuf = Buffer.from(JSON.stringify(this.chunks), "utf8");
      const vectorsBuf = Buffer.from(
        this.vectors.buffer,
        this.vectors.byteOffset,
        this.vectors.byteLength,
      );
      const manifest: StoreManifest = {
        version: 1,
        count: this.chunks.length,
        dimensions: this.dimensions,
        chunksSha256: sha256(chunksBuf),
        vectorsSha256: sha256(vectorsBuf),
      };
      // Each file is replaced atomically, and the manifest goes last: a crash
      // anywhere before it is caught on load (see MANIFEST_FILE).
      writeFileAtomicSync(vectorsPath, vectorsBuf);
      writeFileAtomicSync(chunksPath, chunksBuf);
      writeFileAtomicSync(join(this.storePath, MANIFEST_FILE), JSON.stringify(manifest));

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
