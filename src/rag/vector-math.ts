/**
 * Dense vector math utilities for the RAG system.
 * All operations assume finite, non-NaN values unless otherwise noted.
 */

/**
 * Compute the L2 (Euclidean) norm of a vector.
 */
export function vectorNorm(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]! * v[i]!;
  }
  return Math.sqrt(sum);
}

/**
 * Compute the dot product of two same-length vectors.
 * Callers are responsible for ensuring a.length === b.length.
 */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

/**
 * Normalize a vector to unit length in-place.
 * Returns the original L2 norm before normalization.
 * If the vector is the zero vector (norm === 0) it is left unchanged and 0 is returned.
 */
export function normalizeVector(v: number[]): number {
  const norm = vectorNorm(v);
  if (norm === 0) {
    return 0;
  }
  for (let i = 0; i < v.length; i++) {
    v[i] = v[i]! / norm;
  }
  return norm;
}

/**
 * Cosine similarity between two dense vectors.
 * Returns a value in [-1, 1], or 0 if either vector is the zero vector.
 * Optimised as a single tight loop to avoid recomputing norms separately.
 */
export function denseCosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}
