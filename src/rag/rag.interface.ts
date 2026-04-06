/**
 * Type-safe RAG (Retrieval-Augmented Generation) Interfaces
 * 
 * Provides:
 * - Type-safe vector operations with dimension constraints
 * - Generic chunk types with discriminated unions
 * - Structured search results
 */

import type { 
  Vector, 
  Embedding,
  TimestampMs,
  DurationMs,
  NormalizedScore,
  FilePath,
  Percentage,
  JsonObject 
} from "../types/index.js";

// =============================================================================
// DIMENSION TYPE ALIASES
// =============================================================================

/** Common embedding dimensions */
export type Dimension1536 = 1536;  // OpenAI text-embedding-3-small
export type Dimension3072 = 3072;  // OpenAI text-embedding-3-large
export type Dimension768 = 768;    // sentence-transformers, Ollama
export type Dimension384 = 384;    // MiniLM
export type Dimension1024 = 1024;  // Some models

/** Common vector types by dimension */
export type Vector1536 = Vector<Dimension1536>;
export type Vector3072 = Vector<Dimension3072>;
export type Vector768 = Vector<Dimension768>;
export type Vector384 = Vector<Dimension384>;
export type Vector1024 = Vector<Dimension1024>;

/** Common embedding types by dimension */
export type Embedding1536 = Embedding<Dimension1536>;
export type Embedding3072 = Embedding<Dimension3072>;
export type Embedding768 = Embedding<Dimension768>;
export type Embedding384 = Embedding<Dimension384>;
export type Embedding1024 = Embedding<Dimension1024>;

// =============================================================================
// CHUNK TYPES - Discriminated by Kind
// =============================================================================

/** Code chunk kinds */
export type CodeChunkKind =
  | "class"
  | "struct"
  | "interface"
  | "enum"
  | "method"
  | "function"
  | "constructor"
  | "property"
  | "field"
  | "namespace"
  | "file_header"
  | "region"
  | "comment_block"
  | "unknown";

/** Documentation chunk kinds */
export type DocChunkKind =
  | "markdown"
  | "xml_doc"
  | "readme"
  | "changelog"
  | "license"
  | "api_doc";

/** All chunk kinds */
export type ChunkKind = CodeChunkKind | DocChunkKind | "generic";

/** Base chunk interface */
interface BaseChunk {
  readonly id: string;
  readonly content: string;
  readonly contentHash: string;
  readonly filePath: FilePath;
  readonly indexedAt: TimestampMs;
  readonly embedding?: Vector<number>;
}

/** Code chunk with structural metadata */
export interface CodeChunk extends BaseChunk {
  readonly kind: CodeChunkKind;
  readonly startLine: number;
  readonly endLine: number;
  /** Symbol name (e.g., class name, method name) */
  readonly symbol?: string;
  /** Parent symbol (e.g., containing class) */
  readonly parentSymbol?: string;
  /** Namespace or module */
  readonly namespace?: string;
  /** Programming language */
  readonly language: string;
  /** Access modifier */
  readonly accessModifier?: "public" | "private" | "protected" | "internal" | "static";
  /** Generic type parameters for C#/TypeScript */
  readonly typeParameters?: string[];
}

/** Documentation chunk */
export interface DocumentationChunk extends BaseChunk {
  readonly kind: DocChunkKind;
  readonly title?: string;
  readonly section?: string;
  readonly hierarchy?: string[]; // e.g., ["ClassName", "MethodName"]
}

/** Generic chunk for other content */
export interface GenericChunk extends BaseChunk {
  readonly kind: "generic";
  readonly metadata: JsonObject;
}

/** Discriminated union of all chunk types */
export type Chunk = CodeChunk | DocumentationChunk | GenericChunk;

// =============================================================================
// TYPE GUARDS
// =============================================================================

/** Check if chunk is a code chunk */
export function isCodeChunk(chunk: Chunk): chunk is CodeChunk {
  const codeKinds: CodeChunkKind[] = [
    "class", "struct", "interface", "enum", "method", "function",
    "constructor", "property", "field", "namespace", "file_header",
    "region", "comment_block", "unknown"
  ];
  return codeKinds.includes(chunk.kind as CodeChunkKind);
}

/** Check if chunk is documentation */
export function isDocumentationChunk(chunk: Chunk): chunk is DocumentationChunk {
  const docKinds: DocChunkKind[] = [
    "markdown", "xml_doc", "readme", "changelog", "license", "api_doc"
  ];
  return docKinds.includes(chunk.kind as DocChunkKind);
}

/** Check if chunk has line numbers */
export function hasLineNumbers(chunk: Chunk): chunk is CodeChunk {
  return isCodeChunk(chunk) && "startLine" in chunk;
}

/** Check if chunk has embedding */
export function hasEmbedding<D extends number>(chunk: Chunk): chunk is Chunk & { embedding: Vector<D> } {
  return chunk.embedding !== undefined;
}

// =============================================================================
// SEARCH TYPES
// =============================================================================

/** Search result with relevance scoring */
export interface SearchResult<T extends Chunk = Chunk> {
  /** The matched chunk */
  readonly chunk: T;
  /** Vector similarity score (cosine similarity) */
  readonly vectorScore: NormalizedScore;
  /** Reranked score (after cross-encoder if used) */
  readonly rerankScore?: NormalizedScore;
  /** Final combined score */
  readonly finalScore: NormalizedScore;
  /** Matched keywords (for hybrid search) */
  readonly matchedKeywords?: string[];
  /** Explanation of why this result was selected */
  readonly matchExplanation?: string;
}

/** Alias for SearchResult used in RAG pipeline */
export type RAGSearchResult = SearchResult;

/** Search options */
export interface SearchOptions {
  /** Maximum number of results */
  readonly topK?: number;
  /** Minimum similarity score (0-1) */
  readonly minScore?: NormalizedScore;
  /** Filter by chunk kinds */
  readonly kinds?: ChunkKind[];
  /** Filter by file pattern (glob) */
  readonly filePattern?: string;
  /** Filter by language */
  readonly language?: string;
  /** Use reranking */
  readonly useReranking?: boolean;
  /** Candidate multiplier for reranking (fetch N*topK candidates) */
  readonly candidateMultiplier?: number;
  /** Hybrid search: weight for vector vs keyword (0-1, 1 = pure vector) */
  readonly vectorWeight?: NormalizedScore;
  /** Pre-computed query embedding to avoid redundant embedding calls */
  readonly queryEmbedding?: number[];
}

/** Hybrid search query */
export interface HybridSearchQuery {
  /** Semantic query for vector search */
  readonly semanticQuery: string;
  /** Keyword query for BM25/TF-IDF */
  readonly keywordQuery?: string;
  /** Weight for vector component (0-1) */
  readonly vectorWeight?: NormalizedScore;
}

/** RAG context for LLM */
export interface RAGContext {
  /** Formatted context string */
  readonly text: string;
  /** Source chunks with metadata */
  readonly sources: SearchResult[];
  /** Total tokens in context */
  readonly tokenCount: number;
  /** Context window budget used */
  readonly budgetUsed: number;
}

/** Context budget configuration */
export interface ContextBudget {
  /** Maximum tokens for context */
  readonly maxTokens: number;
  /** How to handle exceeding budget */
  readonly truncationStrategy: "drop_lowest" | "truncate_content" | "none";
  /** Context lines around code snippets */
  readonly contextLines: number;
  /** Reserve tokens for response */
  readonly reserveTokens?: number;
}

/** Default context budget */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: 4000,
  truncationStrategy: "drop_lowest",
  contextLines: 3,
  reserveTokens: 1000,
};

// =============================================================================
// VECTOR STORE TYPES
// =============================================================================

/** Vector store entry */
export interface VectorEntry<D extends number = number> {
  readonly id: string;
  readonly vector: Vector<D>;
  readonly chunk: Chunk;
  /** Timestamp when added */
  readonly addedAt: TimestampMs;
  /** Access count for importance scoring */
  readonly accessCount: number;
  /** Last access timestamp */
  readonly lastAccessedAt?: TimestampMs;
}

/** Vector search hit */
export interface VectorSearchHit {
  readonly id: string;
  readonly chunk: Chunk;
  readonly score: NormalizedScore;
  /** Distance metric used */
  readonly distanceMetric?: "cosine" | "euclidean" | "dot";
}

/** Vector store configuration */
export interface VectorStoreConfig<D extends number = number> {
  /** Vector dimensions */
  readonly dimensions: D;
  /** Distance metric */
  readonly distanceMetric: "cosine" | "euclidean" | "dot";
  /** Index type */
  readonly indexType: "flat" | "hnsw" | "ivf";
  /** HNSW parameters (if applicable) */
  readonly hnswParams?: {
    readonly M: number;
    readonly efConstruction: number;
    readonly efSearch: number;
  };
  /** Quantization settings */
  readonly quantization?: {
    readonly type: "none" | "binary" | "scalar" | "product";
    readonly bits?: number;
  };
  /** Maximum number of vectors */
  readonly maxElements: number;
}

/** Vector store interface */
export interface IVectorStore<D extends number = number> {
  /** Initialize the store */
  initialize(): Promise<void>;
  
  /** Shutdown and cleanup */
  shutdown(): Promise<void>;
  
  /** Add or update vectors */
  upsert(entries: VectorEntry<D>[]): Promise<void>;
  
  /** Remove vectors by ID */
  remove(ids: string[]): Promise<void>;
  
  /** Remove all vectors for a file */
  removeByFile(filePath: FilePath): Promise<void>;
  
  /** Search for similar vectors */
  search(queryVector: Vector<D>, topK: number): Promise<VectorSearchHit[]>;
  
  /** Get current count */
  count(): number;
  
  /** Check if ID exists */
  has(id: string): boolean;
  
  /** Get all chunk IDs for a file */
  getFileChunkIds(filePath: FilePath): string[];
  
  /** Get store statistics (optional) */
  getStats?(): VectorStoreStats;
}

/** Vector store statistics */
export interface VectorStoreStats {
  readonly totalVectors: number;
  readonly dimensions: number;
  readonly indexType: string;
  readonly memoryUsedBytes: number;
  readonly quantizationType?: string;
  readonly compressionRatio?: number;
  readonly averageSearchTimeMs: number;
}

// =============================================================================
// EMBEDDING PROVIDER TYPES
// =============================================================================

/** Embedding provider interface */
export interface IEmbeddingProvider<D extends number = number> {
  /** Provider name */
  readonly name: string;
  /** Output dimensions */
  readonly dimensions: D;
  /** Maximum input length */
  readonly maxInputLength?: number;
  
  /** Generate embeddings for texts */
  embed(texts: string[]): Promise<EmbeddingBatch<D>>;
  
  /** Generate single embedding (optional convenience method) */
  embedOne?(text: string): Promise<Embedding<D>>;
}

/** Embedding batch result */
export interface EmbeddingBatch<D extends number = number> {
  readonly embeddings: Embedding<D>[];
  readonly usage: {
    readonly totalTokens: number;
    readonly promptTokens?: number;
  };
  readonly model?: string;
  readonly dimensions?: D;
}

/** Legacy alias for EmbeddingBatch */
export type EmbeddingResult = EmbeddingBatch;

/** Provider error */
export interface ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
}

/** OpenAI embedding provider config */
export interface OpenAIEmbeddingConfig {
  readonly apiKey: string;
  readonly model?: "text-embedding-3-small" | "text-embedding-3-large" | "text-embedding-ada-002";
  readonly baseUrl?: string;
  readonly dimensions?: number;
}

/** Ollama embedding provider config */
export interface OllamaEmbeddingConfig {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
}

// =============================================================================
// RERANKER TYPES
// =============================================================================

/** Reranker interface */
export interface IReranker {
  readonly name: string;
  
  /** Rerank search results */
  rerank(query: string, results: SearchResult[], topK: number): Promise<SearchResult[]>;
  
  /** Batch rerank multiple queries (optional) */
  rerankBatch?(queries: string[], results: SearchResult[][]): Promise<SearchResult[][]>;
}

/** Reranker result */
export interface RerankResult {
  readonly index: number;
  readonly score: NormalizedScore;
  readonly relevanceScore: NormalizedScore;
}

// =============================================================================
// RAG PIPELINE TYPES
// =============================================================================

/** RAG pipeline configuration */
export interface RAGPipelineConfig {
  /** Embedding provider */
  readonly embeddingProvider: IEmbeddingProvider;
  /** Vector store */
  readonly vectorStore: IVectorStore;
  /** Optional reranker */
  readonly reranker?: IReranker;
  /** Chunking configuration */
  readonly chunking: ChunkingConfig;
  /** Default search options */
  readonly defaultSearchOptions?: SearchOptions;
  /** Default context budget */
  readonly defaultContextBudget?: ContextBudget;
  /** Whether to enable caching */
  readonly enableCache?: boolean;
}

/** Chunking configuration */
export interface ChunkingConfig {
  /** Maximum chunk size in tokens (approximate) */
  readonly maxChunkSize: number;
  /** Chunk overlap in tokens */
  readonly overlapTokens: number;
  /** Whether to respect code boundaries */
  readonly respectBoundaries: boolean;
  /** Language-specific settings */
  readonly languageSettings?: Record<string, LanguageChunkingSettings>;
}

/** Language-specific chunking settings */
export interface LanguageChunkingSettings {
  /** Comment syntax */
  readonly commentStart?: string;
  readonly commentEnd?: string;
  /** String delimiters */
  readonly stringDelimiters?: string[];
  /** Statement terminator */
  readonly statementTerminator?: string;
}

/** Default chunking config */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkSize: 512,
  overlapTokens: 50,
  respectBoundaries: true,
};

/** Indexing statistics */
export interface IndexingStats {
  readonly totalFiles: number;
  readonly totalChunks: number;
  readonly indexedAt: TimestampMs;
  readonly durationMs: DurationMs;
  readonly changedFiles: number;
  readonly errors: IndexingError[];
}

/** Indexing error */
export interface IndexingError {
  readonly filePath: FilePath;
  readonly error: string;
  readonly line?: number;
}

/** File indexing progress */
export interface IndexingProgress {
  readonly currentFile: FilePath;
  readonly filesProcessed: number;
  readonly totalFiles: number;
  readonly chunksCreated: number;
  readonly percentage: Percentage;
}

/** RAG pipeline interface */
export interface IRAGPipeline {
  /** Initialize the pipeline */
  initialize(): Promise<void>;
  
  /** Shutdown and cleanup */
  shutdown(): Promise<void>;
  
  /** Index a single file */
  indexFile(filePath: string, content: string): Promise<number>;
  
  /** Remove a file from the index */
  removeFile(filePath: string): Promise<void>;
  
  /** Index an entire project */
  indexProject(projectPath: string, options?: {
    onProgress?: (progress: IndexingProgress) => void;
    signal?: AbortSignal;
  }): Promise<IndexingStats>;
  
  /** Search for relevant chunks */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  
  /** Format search results into context */
  formatContext(results: SearchResult[], budget?: ContextBudget): string;
  
  /** Get pipeline statistics */
  getStats(): IndexingStats;
}

/** RAG statistics */
export interface RAGStats {
  readonly totalFilesIndexed: number;
  readonly totalChunks: number;
  readonly vectorStoreStats: VectorStoreStats;
  readonly lastIndexedAt?: TimestampMs;
  readonly averageQueryTimeMs: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Calculate token count using character-class heuristic.
 *
 * ASCII text averages ~4 chars/token, CJK characters average ~1.5 chars/token.
 * This weighted approach gives better estimates for mixed-language content.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let asciiChars = 0;
  let cjkChars = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs + common CJK ranges
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af)    // Hangul
    ) {
      cjkChars++;
    } else {
      asciiChars++;
    }
  }

  return Math.ceil(asciiChars / 4 + cjkChars / 1.5);
}

/**
 * Check if context exceeds budget
 */
export function exceedsBudget(context: RAGContext, budget: ContextBudget): boolean {
  return context.tokenCount > budget.maxTokens - (budget.reserveTokens ?? 0);
}

/**
 * Sort search results by final score
 */
export function sortByRelevance<T extends Chunk>(results: SearchResult<T>[]): SearchResult<T>[] {
  return [...results].sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Filter results by minimum score
 */
export function filterByMinScore<T extends Chunk>(
  results: SearchResult<T>[],
  minScore: NormalizedScore
): SearchResult<T>[] {
  return results.filter((r) => r.finalScore >= minScore);
}

/**
 * Deduplicate results by file path
 */
export function deduplicateByFile<T extends Chunk>(results: SearchResult<T>[]): SearchResult<T>[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.chunk.filePath)) return false;
    seen.add(r.chunk.filePath);
    return true;
  });
}

/**
 * Format code chunk for display
 */
export function formatCodeChunk(chunk: CodeChunk, _contextLines: number = 3): string {
  const lines = chunk.content.split("\n");
  const header = chunk.symbol 
    ? `${chunk.kind}: ${chunk.symbol}` 
    : `${chunk.kind} in ${chunk.filePath}`;
  
  return [
    `// ${header} (${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`,
    ...lines.slice(0, 10), // Limit displayed lines
    lines.length > 10 ? "// ..." : "",
  ].join("\n");
}

/**
 * Create a search result
 */
export function createSearchResult<T extends Chunk>(
  chunk: T,
  vectorScore: number,
  options?: {
    rerankScore?: number;
    matchedKeywords?: string[];
    matchExplanation?: string;
  }
): SearchResult<T> {
  const finalScore = options?.rerankScore !== undefined
    ? (vectorScore + options.rerankScore) / 2
    : vectorScore;
  
  return {
    chunk,
    vectorScore: vectorScore as NormalizedScore,
    rerankScore: options?.rerankScore as NormalizedScore | undefined,
    finalScore: finalScore as NormalizedScore,
    matchedKeywords: options?.matchedKeywords,
    matchExplanation: options?.matchExplanation,
  };
}
