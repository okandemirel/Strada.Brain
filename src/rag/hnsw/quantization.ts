/**
 * Vector Quantization for Memory Efficiency
 * 
 * Implements binary, scalar, and product quantization for 4-32x memory reduction
 * Based on AgentDB quantization strategies
 */

import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

/**
 * Quantization type for vectors
 */
export type QuantizationType = "none" | "binary" | "scalar" | "product";

/**
 * Quantized vector representation
 */
export interface QuantizedVector {
  /** Original dimensions */
  dimensions: number;
  /** Quantization type used */
  type: QuantizationType;
  /** Quantized data */
  data: Uint8Array | Int8Array | Float32Array;
  /** Scaling factors for reconstruction (scalar/product) */
  scales?: Float32Array;
  /** Min/max values for scalar quantization */
  minVal?: number;
  maxVal?: number;
}

/**
 * Quantization statistics
 */
export interface QuantizationStats {
  type: QuantizationType;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  compressionRatio: number;
  reconstructionError: number;
}

/**
 * Binary Quantization: 32x memory reduction
 * Converts float32 vectors to binary (sign bit only)
 * 768-dim float32 (3072 bytes) → 768 bits (96 bytes)
 */
export function binaryQuantize(vector: number[] | Float32Array): QuantizedVector {
  const dimensions = vector.length;
  const numBytes = Math.ceil(dimensions / 8);
  const data = new Uint8Array(numBytes);

  for (let i = 0; i < dimensions; i++) {
    if (vector[i]! > 0) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      data[byteIndex]! |= 1 << bitIndex;
    }
  }

  return {
    dimensions,
    type: "binary",
    data,
  };
}

/**
 * Reconstruct vector from binary quantization
 * Returns approximate vector with unit magnitude
 */
export function binaryDequantize(quantized: QuantizedVector): Float32Array {
  const { dimensions, data } = quantized;
  const vector = new Float32Array(dimensions);

  for (let i = 0; i < dimensions; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    const isPositive = (data[byteIndex]! & (1 << bitIndex)) !== 0;
    // Approximate reconstruction: ±1/sqrt(dim) for normalized vectors
    vector[i] = isPositive ? 1 / Math.sqrt(dimensions) : -1 / Math.sqrt(dimensions);
  }

  return vector;
}

/**
 * Scalar Quantization: 4x memory reduction (float32 → int8)
 * Maps float32 values to int8 range [-128, 127]
 * Best for: Balanced compression/quality tradeoff
 */
export function scalarQuantize(
  vector: number[] | Float32Array,
  minVal?: number,
  maxVal?: number
): QuantizedVector {
  const dimensions = vector.length;
  
  // Compute or use provided min/max
  const actualMin = minVal ?? Math.min(...vector);
  const actualMax = maxVal ?? Math.max(...vector);
  const range = actualMax - actualMin || 1; // Avoid division by zero

  const data = new Int8Array(dimensions);
  
  for (let i = 0; i < dimensions; i++) {
    // Map to [-128, 127]
    const normalized = (vector[i]! - actualMin) / range;
    data[i] = Math.max(-128, Math.min(127, Math.round(normalized * 255 - 128)));
  }

  return {
    dimensions,
    type: "scalar",
    data,
    minVal: actualMin,
    maxVal: actualMax,
  };
}

/**
 * Reconstruct vector from scalar quantization
 */
export function scalarDequantize(quantized: QuantizedVector): Float32Array {
  const { dimensions, data, minVal, maxVal } = quantized;
  
  if (minVal === undefined || maxVal === undefined) {
    throw new Error("Scalar quantization requires minVal and maxVal");
  }

  const vector = new Float32Array(dimensions);
  const range = maxVal - minVal;

  for (let i = 0; i < dimensions; i++) {
    // Map from [-128, 127] back to original range
    const normalized = (data[i]! + 128) / 255;
    vector[i] = minVal + normalized * range;
  }

  return vector;
}

/**
 * Product Quantization: 8-16x memory reduction
 * Divides vector into subvectors and quantizes each independently
 * Best for: Large-scale applications with memory constraints
 */
export interface ProductQuantizationConfig {
  /** Number of subvectors (codebooks) */
  numSubvectors: number;
  /** Bits per code (typically 8 for 256 centroids) */
  bitsPerCode: number;
}

/**
 * Product quantizer with learned codebooks
 */
export class ProductQuantizer {
  private codebooks: Float32Array[][] = [];
  private config: ProductQuantizationConfig;
  private dimensions: number;

  constructor(dimensions: number, config: ProductQuantizationConfig = { numSubvectors: 8, bitsPerCode: 8 }) {
    this.dimensions = dimensions;
    this.config = config;
  }

  /**
   * Train codebooks on sample vectors
   */
  train(vectors: Float32Array[]): void {
    const subvectorDim = Math.floor(this.dimensions / this.config.numSubvectors);
    const numCentroids = 1 << this.config.bitsPerCode; // 2^bitsPerCode

    this.codebooks = [];

    for (let m = 0; m < this.config.numSubvectors; m++) {
      const codebook: Float32Array[] = [];
      
      // Simple k-means initialization (random samples as centroids)
      // In production, use proper k-means++ initialization
      const startIdx = m * subvectorDim;
      const endIdx = Math.min(startIdx + subvectorDim, this.dimensions);
      
      for (let k = 0; k < Math.min(numCentroids, vectors.length); k++) {
        const centroid = new Float32Array(subvectorDim);
        for (let i = 0; i < subvectorDim && startIdx + i < endIdx; i++) {
          centroid[i] = vectors[k]?.[startIdx + i] ?? 0;
        }
        codebook.push(centroid);
      }

      this.codebooks.push(codebook);
    }

    getLoggerSafe().debug("Product quantizer trained", {
      numSubvectors: this.config.numSubvectors,
      bitsPerCode: this.config.bitsPerCode,
      numCentroids,
    });
  }

  /**
   * Quantize a vector using product quantization
   */
  quantize(vector: Float32Array): QuantizedVector {
    const codes = new Uint8Array(this.config.numSubvectors);
    const subvectorDim = Math.floor(this.dimensions / this.config.numSubvectors);

    for (let m = 0; m < this.config.numSubvectors; m++) {
      const startIdx = m * subvectorDim;
      let minDist = Infinity;
      let bestCode = 0;

      // Find nearest centroid
      for (let k = 0; k < this.codebooks[m]!.length; k++) {
        const centroid = this.codebooks[m]![k]!;
        let dist = 0;

        for (let i = 0; i < subvectorDim && startIdx + i < vector.length; i++) {
          const diff = vector[startIdx + i]! - (centroid[i] ?? 0);
          dist += diff * diff;
        }

        if (dist < minDist) {
          minDist = dist;
          bestCode = k;
        }
      }

      codes[m] = bestCode;
    }

    return {
      dimensions: this.dimensions,
      type: "product",
      data: codes,
    };
  }

  /**
   * Reconstruct vector from product quantization
   */
  dequantize(quantized: QuantizedVector): Float32Array {
    const { data: codes } = quantized;
    const vector = new Float32Array(this.dimensions);
    const subvectorDim = Math.floor(this.dimensions / this.config.numSubvectors);

    for (let m = 0; m < this.config.numSubvectors; m++) {
      const centroid = this.codebooks[m]![codes[m]!];
      if (!centroid) continue;

      const startIdx = m * subvectorDim;
      for (let i = 0; i < subvectorDim && startIdx + i < vector.length; i++) {
        vector[startIdx + i] = centroid[i] ?? 0;
      }
    }

    return vector;
  }

  /**
   * Compute asymmetric distance (query to quantized vector)
   * More efficient than full dequantization
   */
  computeDistance(query: Float32Array, quantized: QuantizedVector): number {
    const { data: codes } = quantized;
    let totalDist = 0;
    const subvectorDim = Math.floor(this.dimensions / this.config.numSubvectors);

    for (let m = 0; m < this.config.numSubvectors; m++) {
      const centroid = this.codebooks[m]![codes[m]!];
      if (!centroid) continue;

      const startIdx = m * subvectorDim;
      for (let i = 0; i < subvectorDim && startIdx + i < query.length; i++) {
        const diff = query[startIdx + i]! - (centroid[i] ?? 0);
        totalDist += diff * diff;
      }
    }

    return Math.sqrt(totalDist);
  }
}

/**
 * Quantize a batch of vectors with specified type
 */
export function quantizeBatch(
  vectors: Float32Array[],
  type: QuantizationType,
  productQuantizer?: ProductQuantizer
): QuantizedVector[] {
  switch (type) {
    case "binary":
      return vectors.map(v => binaryQuantize(v));
    case "scalar": {
      // Compute global min/max for consistent scaling
      let globalMin = Infinity;
      let globalMax = -Infinity;
      for (const v of vectors) {
        for (const val of v) {
          globalMin = Math.min(globalMin, val);
          globalMax = Math.max(globalMax, val);
        }
      }
      return vectors.map(v => scalarQuantize(v, globalMin, globalMax));
    }
    case "product": {
      if (!productQuantizer) {
        throw new Error("Product quantizer required for product quantization");
      }
      return vectors.map(v => productQuantizer.quantize(v));
    }
    case "none":
    default:
      return vectors.map(v => ({
        dimensions: v.length,
        type: "none",
        data: new Float32Array(v),
      }));
  }
}

/**
 * Dequantize a batch of vectors
 */
export function dequantizeBatch(
  quantized: QuantizedVector[],
  productQuantizer?: ProductQuantizer
): Float32Array[] {
  return quantized.map(q => {
    switch (q.type) {
      case "binary":
        return binaryDequantize(q);
      case "scalar":
        return scalarDequantize(q);
      case "product": {
        if (!productQuantizer) {
          throw new Error("Product quantizer required for product dequantization");
        }
        return productQuantizer.dequantize(q);
      }
      case "none":
      default:
        return new Float32Array(q.data as Float32Array);
    }
  });
}

/**
 * Compute compression statistics
 */
export function computeQuantizationStats(
  original: Float32Array[],
  quantized: QuantizedVector[]
): QuantizationStats {
  const originalSize = original.length * original[0]!.length * 4; // 4 bytes per float32
  
  let compressedSize = 0;
  for (const q of quantized) {
    compressedSize += q.data.length;
    if (q.scales) compressedSize += q.scales.length * 4;
  }

  // Compute reconstruction error
  const dequantized = dequantizeBatch(quantized);
  let totalError = 0;
  for (let i = 0; i < original.length; i++) {
    const orig = original[i]!;
    const recon = dequantized[i]!;
    for (let j = 0; j < orig.length; j++) {
      const diff = orig[j]! - recon[j]!;
      totalError += diff * diff;
    }
  }
  const rmse = Math.sqrt(totalError / (original.length * original[0]!.length));

  return {
    type: quantized[0]?.type ?? "none",
    originalSizeBytes: originalSize,
    compressedSizeBytes: compressedSize,
    compressionRatio: originalSize / compressedSize,
    reconstructionError: rmse,
  };
}

/**
 * Get recommended quantization type based on use case
 */
export function getRecommendedQuantization(dimensions: number, vectorCount: number): QuantizationType {
  const totalMemoryMB = (dimensions * vectorCount * 4) / (1024 * 1024);

  if (totalMemoryMB > 1000) {
    // > 1GB: Use binary for maximum compression
    return "binary";
  } else if (totalMemoryMB > 100) {
    // > 100MB: Use product quantization
    return "product";
  } else if (totalMemoryMB > 10) {
    // > 10MB: Use scalar quantization
    return "scalar";
  }
  // Small dataset: No quantization needed
  return "none";
}
