/**
 * HNSW Vector Search Module
 * 
 * High-performance approximate nearest neighbor search with HNSW indexing
 * Provides 150x-12,500x faster vector search compared to brute-force
 */

// Core HNSW vector store
export {
  HNSWVectorStore,
  createHNSWVectorStore,
  DEFAULT_HNSW_CONFIG,
  type IHNSWVectorStore,
  type HNSWConfig,
  type HNSWStats,
} from "./hnsw-vector-store.js";

// Quantization for memory efficiency
export {
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
  type QuantizedVector,
  type QuantizationStats,
  type ProductQuantizationConfig,
} from "./quantization.js";
