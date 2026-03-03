/**
 * Mock HNSW implementation for testing
 * Used when hnswlib-node is not available
 */

import { denseCosineSimilarity } from "../vector-math.js";

export interface MockHNSWConfig {
  metric: "l2" | "cosine" | "ip";
  dimensions: number;
}

export interface SearchResult {
  neighbors: number[];
  distances: number[];
}

/**
 * Mock HNSW index for testing without native dependencies
 */
export class MockHierarchicalNSW {
  private metric: string;
  private vectors: Map<number, Float32Array> = new Map();
  private isInitialized = false;

  constructor(metric: string, _dimensions: number) {
    this.metric = metric;
  }

  initIndex(_maxElements: number, _M: number, _efConstruction: number, _seed: number): void {
    this.isInitialized = true;
  }

  setEfSearch(_efSearch: number): void {
    // No-op for mock
  }

  addPoint(vector: Float32Array, index: number): void {
    if (!this.isInitialized) {
      throw new Error("Index not initialized");
    }
    this.vectors.set(index, new Float32Array(vector));
  }

  searchKnn(query: Float32Array, k: number): SearchResult {
    if (!this.isInitialized) {
      throw new Error("Index not initialized");
    }

    const scored: Array<{ index: number; distance: number }> = [];

    for (const [index, vector] of this.vectors) {
      let distance: number;
      
      if (this.metric === "cosine") {
        const similarity = denseCosineSimilarity(
          Array.from(query),
          Array.from(vector)
        );
        distance = 1 - similarity;
      } else if (this.metric === "l2") {
        distance = 0;
        for (let i = 0; i < query.length; i++) {
          const diff = query[i]! - vector[i]!;
          distance += diff * diff;
        }
        distance = Math.sqrt(distance);
      } else {
        // Dot product
        distance = 0;
        for (let i = 0; i < query.length; i++) {
          distance += query[i]! * vector[i]!;
        }
      }

      scored.push({ index, distance });
    }

    // Sort by distance (ascending)
    scored.sort((a, b) => a.distance - b.distance);

    const topK = scored.slice(0, k);
    
    return {
      neighbors: topK.map(s => s.index),
      distances: topK.map(s => s.distance),
    };
  }

  markDelete(index: number): void {
    this.vectors.delete(index);
  }

  writeIndex(_path: string): void {
    // No-op for mock
  }

  readIndex(_path: string): void {
    // No-op for mock
  }
}

/**
 * Try to load hnswlib-node, fallback to mock
 */
export async function loadHNSW() {
  try {
    const hnsw = await import("hnswlib-node");
    return hnsw;
  } catch {
    // Return mock implementation
    return {
      HierarchicalNSW: MockHierarchicalNSW,
    };
  }
}
