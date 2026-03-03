import { describe, it, expect, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});
import {
  binaryQuantize,
  binaryDequantize,
  scalarQuantize,
  scalarDequantize,
  ProductQuantizer,
  quantizeBatch,
  dequantizeBatch,
  computeQuantizationStats,
  getRecommendedQuantization,
  type QuantizationType,
} from "./quantization.js";

describe("Quantization", () => {
  function createTestVector(dimensions: number): Float32Array {
    const vec = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      vec[i] = Math.sin(i * 0.1) * 2; // Sine wave for variety
    }
    return vec;
  }

  function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
  }

  describe("binary quantization", () => {
    it("should quantize and reconstruct vector", () => {
      const original = createTestVector(128);
      const quantized = binaryQuantize(original);
      const reconstructed = binaryDequantize(quantized);

      expect(quantized.type).toBe("binary");
      expect(quantized.dimensions).toBe(128);
      expect(quantized.data.length).toBe(16); // 128 bits / 8 = 16 bytes

      // Reconstructed should have same sign pattern (or zero)
      for (let i = 0; i < original.length; i++) {
        const origSign = Math.sign(original[i]!);
        const reconSign = Math.sign(reconstructed[i]!);
        // Zero can be reconstructed as either positive or negative
        if (origSign !== 0) {
          expect(reconSign).toBe(origSign);
        }
      }
    });

    it("should achieve 32x compression", () => {
      const original = createTestVector(768);
      const originalSize = original.length * 4; // 4 bytes per float32
      
      const quantized = binaryQuantize(original);
      const compressedSize = quantized.data.length;

      expect(compressedSize).toBe(96); // 768 bits / 8 = 96 bytes
      expect(originalSize / compressedSize).toBeCloseTo(32, 0);
    });

    it("should preserve similarity approximately", () => {
      const vec1 = createTestVector(128);
      const vec2 = createTestVector(128);
      
      const q1 = binaryQuantize(vec1);
      const q2 = binaryQuantize(vec2);
      
      const r1 = binaryDequantize(q1);
      const r2 = binaryDequantize(q2);

      const originalSim = cosineSimilarity(vec1, vec2);
      const quantizedSim = cosineSimilarity(r1, r2);

      // Similarity should be roughly preserved
      expect(Math.abs(originalSim - quantizedSim)).toBeLessThan(0.3);
    });
  });

  describe("scalar quantization", () => {
    it("should quantize and reconstruct vector", () => {
      const original = createTestVector(128);
      const quantized = scalarQuantize(original);
      const reconstructed = scalarDequantize(quantized);

      expect(quantized.type).toBe("scalar");
      expect(quantized.dimensions).toBe(128);
      expect(quantized.data.length).toBe(128); // One int8 per dimension

      // Values should be close to original
      let maxError = 0;
      for (let i = 0; i < original.length; i++) {
        maxError = Math.max(maxError, Math.abs(original[i]! - reconstructed[i]!));
      }
      expect(maxError).toBeLessThan(0.1);
    });

    it("should achieve 4x compression", () => {
      const original = createTestVector(768);
      const originalSize = original.length * 4;
      
      const quantized = scalarQuantize(original);
      const compressedSize = quantized.data.length;

      expect(compressedSize).toBe(768); // 768 bytes
      expect(originalSize / compressedSize).toBeCloseTo(4, 0);
    });

    it("should use custom min/max values", () => {
      const original = new Float32Array([0.5, 1.0, 1.5, 2.0]);
      const quantized = scalarQuantize(original, 0, 2);

      expect(quantized.minVal).toBe(0);
      expect(quantized.maxVal).toBe(2);
    });

    it("should preserve similarity better than binary", () => {
      const vec1 = createTestVector(128);
      const vec2 = createTestVector(128);
      
      const q1 = scalarQuantize(vec1);
      const q2 = scalarQuantize(vec2);
      
      const r1 = scalarDequantize(q1);
      const r2 = scalarDequantize(q2);

      const originalSim = cosineSimilarity(vec1, vec2);
      const quantizedSim = cosineSimilarity(r1, r2);

      // Scalar should preserve similarity better than binary
      expect(Math.abs(originalSim - quantizedSim)).toBeLessThan(0.05);
    });
  });

  describe("product quantization", () => {
    it("should train and quantize vectors", () => {
      const pq = new ProductQuantizer(128, { numSubvectors: 8, bitsPerCode: 8 });
      
      // Training data
      const trainingData: Float32Array[] = [];
      for (let i = 0; i < 100; i++) {
        trainingData.push(createTestVector(128));
      }

      pq.train(trainingData);

      // Quantize
      const original = createTestVector(128);
      const quantized = pq.quantize(original);

      expect(quantized.type).toBe("product");
      expect(quantized.dimensions).toBe(128);
      expect(quantized.data.length).toBe(8); // 8 subvectors
    });

    it("should reconstruct vector with reasonable accuracy", () => {
      const pq = new ProductQuantizer(64, { numSubvectors: 4, bitsPerCode: 8 });
      
      const trainingData: Float32Array[] = [];
      for (let i = 0; i < 50; i++) {
        trainingData.push(createTestVector(64));
      }
      pq.train(trainingData);

      const original = createTestVector(64);
      const quantized = pq.quantize(original);
      const reconstructed = pq.dequantize(quantized);

      // Should have reasonable reconstruction
      let error = 0;
      for (let i = 0; i < original.length; i++) {
        error += Math.abs(original[i]! - reconstructed[i]!);
      }
      error /= original.length;
      
      expect(error).toBeLessThan(1.0);
    });

    it("should compute asymmetric distance efficiently", () => {
      const pq = new ProductQuantizer(64, { numSubvectors: 4, bitsPerCode: 8 });
      
      const trainingData: Float32Array[] = [];
      for (let i = 0; i < 50; i++) {
        trainingData.push(createTestVector(64));
      }
      pq.train(trainingData);

      const original = createTestVector(64);
      const quantized = pq.quantize(original);

      const dist = pq.computeDistance(original, quantized);
      expect(dist).toBeGreaterThanOrEqual(0);
    });
  });

  describe("batch operations", () => {
    it("should quantize batch of vectors", () => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < 10; i++) {
        vectors.push(createTestVector(128));
      }

      const quantized = quantizeBatch(vectors, "scalar");

      expect(quantized).toHaveLength(10);
      expect(quantized[0]!.type).toBe("scalar");
    });

    it("should dequantize batch of vectors", () => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < 10; i++) {
        vectors.push(createTestVector(128));
      }

      const quantized = quantizeBatch(vectors, "scalar");
      const reconstructed = dequantizeBatch(quantized);

      expect(reconstructed).toHaveLength(10);
      expect(reconstructed[0]!.length).toBe(128);
    });

    it("should handle binary batch quantization", () => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < 10; i++) {
        vectors.push(createTestVector(128));
      }

      const quantized = quantizeBatch(vectors, "binary");
      const reconstructed = dequantizeBatch(quantized);

      expect(quantized).toHaveLength(10);
      expect(reconstructed).toHaveLength(10);
    });
  });

  describe("statistics", () => {
    it("should compute quantization statistics", () => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < 10; i++) {
        vectors.push(createTestVector(128));
      }

      const quantized = quantizeBatch(vectors, "scalar");
      const stats = computeQuantizationStats(vectors, quantized);

      expect(stats.type).toBe("scalar");
      expect(stats.originalSizeBytes).toBe(10 * 128 * 4);
      expect(stats.compressedSizeBytes).toBe(10 * 128);
      expect(stats.compressionRatio).toBeCloseTo(4, 0);
      expect(stats.reconstructionError).toBeGreaterThanOrEqual(0);
    });

    it("should compute binary statistics correctly", () => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < 10; i++) {
        vectors.push(createTestVector(128));
      }

      const quantized = quantizeBatch(vectors, "binary");
      const stats = computeQuantizationStats(vectors, quantized);

      expect(stats.type).toBe("binary");
      expect(stats.compressionRatio).toBeCloseTo(32, 0);
    });
  });

  describe("recommendations", () => {
    it("should recommend binary for large datasets", () => {
      // > 1GB equivalent
      const recommendation = getRecommendedQuantization(1536, 1000000);
      expect(recommendation).toBe("binary");
    });

    it("should recommend product for medium datasets", () => {
      // 100MB - 1GB
      const recommendation = getRecommendedQuantization(768, 50000);
      expect(recommendation).toBe("product");
    });

    it("should recommend scalar for small-medium datasets", () => {
      // 10MB - 100MB
      const recommendation = getRecommendedQuantization(768, 5000);
      expect(recommendation).toBe("scalar");
    });

    it("should recommend none for small datasets", () => {
      // < 10MB
      const recommendation = getRecommendedQuantization(384, 1000);
      expect(recommendation).toBe("none");
    });
  });
});
