import { describe, it, expect } from "vitest";
import {
  denseCosineSimilarity,
  vectorNorm,
  normalizeVector,
  dotProduct,
} from "./vector-math.js";

describe("denseCosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(denseCosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("returns 1.0 for identical non-unit vectors", () => {
    const a = [3, 4, 0];
    const b = [3, 4, 0];
    expect(denseCosineSimilarity(a, b)).toBeCloseTo(1.0, 10);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(denseCosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it("returns 0.0 for another pair of orthogonal vectors", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(denseCosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(denseCosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it("returns 0 when the first vector is the zero vector", () => {
    expect(denseCosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when the second vector is the zero vector", () => {
    expect(denseCosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns 0 when both vectors are zero vectors", () => {
    expect(denseCosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("returns a value in [-1, 1] for arbitrary vectors", () => {
    const a = [0.5, -0.3, 0.8, 1.2];
    const b = [-0.1, 0.7, 0.2, -0.9];
    const result = denseCosineSimilarity(a, b);
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe("vectorNorm", () => {
  it("returns 5 for [3, 4]", () => {
    expect(vectorNorm([3, 4])).toBeCloseTo(5, 10);
  });

  it("returns 0 for the zero vector", () => {
    expect(vectorNorm([0, 0, 0])).toBe(0);
  });

  it("returns 1 for a unit vector", () => {
    expect(vectorNorm([1, 0, 0])).toBeCloseTo(1, 10);
  });

  it("computes norm of a 3D vector correctly", () => {
    // sqrt(1 + 4 + 9) = sqrt(14)
    expect(vectorNorm([1, 2, 3])).toBeCloseTo(Math.sqrt(14), 10);
  });

  it("handles negative components", () => {
    expect(vectorNorm([-3, 4])).toBeCloseTo(5, 10);
  });
});

describe("normalizeVector", () => {
  it("produces a unit vector", () => {
    const v = [3, 4];
    normalizeVector(v);
    expect(vectorNorm(v)).toBeCloseTo(1.0, 10);
  });

  it("returns the original norm", () => {
    const v = [3, 4];
    const originalNorm = normalizeVector(v);
    expect(originalNorm).toBeCloseTo(5, 10);
  });

  it("normalizes a 3D vector to unit length", () => {
    const v = [1, 2, 3];
    normalizeVector(v);
    expect(vectorNorm(v)).toBeCloseTo(1.0, 10);
  });

  it("preserves direction after normalization", () => {
    const original = [1, 2, 3];
    const v = [...original];
    normalizeVector(v);
    // Ratio of components must be preserved
    expect(v[1] / v[0]).toBeCloseTo(original[1] / original[0], 10);
    expect(v[2] / v[0]).toBeCloseTo(original[2] / original[0], 10);
  });

  it("leaves the zero vector unchanged and returns 0", () => {
    const v = [0, 0, 0];
    const norm = normalizeVector(v);
    expect(norm).toBe(0);
    expect(v).toEqual([0, 0, 0]);
  });

  it("modifies the vector in-place", () => {
    const v = [3, 4];
    const ref = v;
    normalizeVector(v);
    expect(v).toBe(ref); // same array reference
    expect(vectorNorm(v)).toBeCloseTo(1.0, 10);
  });
});

describe("dotProduct", () => {
  it("computes the dot product of two vectors", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32); // 4 + 10 + 18
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(dotProduct([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 when one vector is the zero vector", () => {
    expect(dotProduct([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("handles negative values correctly", () => {
    expect(dotProduct([-1, 2], [3, -4])).toBe(-11); // -3 + -8
  });

  it("returns the squared norm for a vector with itself", () => {
    const v = [3, 4];
    expect(dotProduct(v, v)).toBeCloseTo(25, 10); // 9 + 16
  });

  it("is commutative", () => {
    const a = [1, 2, 3, 4];
    const b = [5, 6, 7, 8];
    expect(dotProduct(a, b)).toBe(dotProduct(b, a));
  });
});
