import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IVectorStore, VectorEntry, VectorSearchHit, CodeChunk } from "./rag.interface.js";
import { getLogger } from "../utils/logger.js";

const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.bin";
const FLUSH_DEBOUNCE_MS = 5_000;
const HNSW_M = 16; // Number of bi-directional links for each element
const HNSW_EF_CONSTRUCTION = 200; // Size of dynamic list for nearest neighbors
const HNSW_EF_SEARCH = 100; // Size of dynamic list for search

/**
 * HNSW (Hierarchical Navigable Small World) index node
 */
interface HNSWNode {
  id: string;
  vector: Float32Array;
  level: number;
  connections: Map<number, Set<number>>; // level -> indices of connected nodes
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
    if (k >= arr.length) return arr;
    
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
    const node: HNSWNode = {
      id,
      vector: new Float32Array(vector), // Copy to ensure isolation
      level,
      connections: new Map(),
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
      currEp = this.searchLayerClosest(vector, currEp, l);
    }

    // Insert at each level from min(level, maxLevel) down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayerKNN(vector, currEp, this.efConstruction, l);
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
    
    // Simple update - in production, you'd want to rewire connections
    this.nodes[idx]!.vector = new Float32Array(vector);
  }

  /**
   * Remove a vector from the index
   */
  remove(id: string): void {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return;

    // Mark as removed (soft delete for performance)
    // In production, implement proper rewiring
    this.idToIndex.delete(id);
    this.nodes[idx] = null as unknown as HNSWNode;
  }

  /**
   * Search for k nearest neighbors
   */
  search(query: Float32Array, k: number): Array<{ id: string; score: number }> {
    if (this.nodes.length === 0 || this.entryPoint < 0) return [];

    const ef = Math.max(k, this.efSearch);
    let currEp = this.entryPoint;

    // Search from top layer down to layer 1
    for (let l = this.maxLevel; l > 0; l--) {
      currEp = this.searchLayerClosest(query, currEp, l);
    }

    // Search layer 0 with full ef
    const candidates = this.searchLayerKNN(query, currEp, ef, 0);
    
    // Return top k
    return candidates
      .slice(0, k)
      .filter(c => this.nodes[c.idx] !== null)
      .map(c => ({
        id: this.nodes[c.idx]!.id,
        score: VectorOps.cosineSimilarity(query, this.nodes[c.idx]!.vector),
      }));
  }

  /**
   * Search layer for closest single point (greedy)
   */
  private searchLayerClosest(query: Float32Array, entryPoint: number, level: number): number {
    let curr = entryPoint;
    let currDist = -VectorOps.cosineSimilarity(query, this.nodes[curr]!.vector);
    let changed = true;

    const visited = new Set<number>([curr]);

    while (changed) {
      changed = false;
      const connections = this.nodes[curr]!.connections.get(level);
      if (!connections) continue;

      for (const neighbor of connections) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const neighborDist = -VectorOps.cosineSimilarity(query, this.nodes[neighbor]!.vector);
        if (neighborDist < currDist) {
          curr = neighbor;
          currDist = neighborDist;
          changed = true;
        }
      }
    }

    return curr;
  }

  /**
   * Search layer for k nearest neighbors
   */
  private searchLayerKNN(
    query: Float32Array,
    entryPoint: number,
    ef: number,
    level: number
  ): Array<{ idx: number; score: number }> {
    const candidates: Array<{ idx: number; score: number }> = [];
    const visited = new Set<number>([entryPoint]);
    const entryScore = VectorOps.cosineSimilarity(query, this.nodes[entryPoint]!.vector);
    
    candidates.push({ idx: entryPoint, score: entryScore });

    // Simple greedy best-first search
    const unchecked = new Set<number>([entryPoint]);

    while (unchecked.size > 0) {
      // Get best unchecked
      let bestIdx = -1;
      let bestScore = -1;
      for (const idx of unchecked) {
        const score = VectorOps.cosineSimilarity(query, this.nodes[idx]!.vector);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }

      if (bestIdx < 0) break;
      unchecked.delete(bestIdx);

      // Check neighbors
      const connections = this.nodes[bestIdx]!.connections.get(level);
      if (!connections) continue;

      for (const neighbor of connections) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const score = VectorOps.cosineSimilarity(query, this.nodes[neighbor]!.vector);
        
        // Add if better than worst in candidates or if candidates < ef
        if (candidates.length < ef) {
          candidates.push({ idx: neighbor, score });
          unchecked.add(neighbor);
        } else if (score > candidates[candidates.length - 1]!.score) {
          candidates[candidates.length - 1] = { idx: neighbor, score };
          unchecked.add(neighbor);
        }

        // Keep candidates sorted and trimmed
        if (candidates.length > 1) {
          candidates.sort((a, b) => b.score - a.score);
          if (candidates.length > ef) {
            candidates.length = ef;
          }
        }
      }
    }

    return candidates;
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

    // Select best m neighbors
    const selected = neighbors.slice(0, mMax);
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

    // Simple heuristic: keep first mMax (could be improved with distance-based selection)
    const newConns = new Set<number>();
    let count = 0;
    for (const conn of conns) {
      if (count >= mMax) break;
      newConns.add(conn);
      count++;
    }
    node.connections.set(level, newConns);
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
  private hnswIndex: HNSWIndex;

  /** chunk id → position index in chunks / vectors */
  private idIndex: Map<string, number> = new Map();
  /** filePath → set of chunk ids */
  private fileIndex: Map<string, Set<string>> = new Map();

  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: boolean = false;

  constructor(storePath: string, dimensions: number) {
    this.storePath = storePath;
    this.dimensions = dimensions;
    this.hnswIndex = new HNSWIndex(dimensions);
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
      this.hnswIndex.clear();
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
      this.hnswIndex.update(entry.id, new Float32Array(entry.vector));
      
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
        this.hnswIndex.add(entry.id, new Float32Array(entry.vector));
      }
    }
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
        this.hnswIndex.remove(chunk.id);
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
    
    // Use HNSW for approximate search when dataset is large enough
    if (n > 100 && this.hnswIndex.size > 0) {
      const hnswResults = this.hnswIndex.search(queryFloat, topK);
      return hnswResults.map(r => ({
        id: r.id,
        chunk: this.chunks[this.idIndex.get(r.id)!]!,
        score: r.score,
        distanceMetric: "cosine" as const,
      }));
    }

    // Fallback to exact search for small datasets
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
    this.hnswIndex.clear();

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      this.idIndex.set(chunk.id, i);
      this.addToFileIndex(chunk.filePath, chunk.id);
      
      // Rebuild HNSW index
      const vector = this.vectors.subarray(i * this.dimensions, (i + 1) * this.dimensions);
      this.hnswIndex.add(chunk.id, vector);
    }
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
