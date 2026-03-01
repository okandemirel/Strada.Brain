/** A chunk of source code with structural metadata */
export interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  kind: "class" | "struct" | "method" | "constructor" | "file_header" | "unknown";
  parentSymbol?: string;
  symbol?: string;
  namespace?: string;
  contentHash: string;
  indexedAt: string; // ISO 8601
}

/** A search result from the vector store */
export interface RAGSearchResult {
  chunk: CodeChunk;
  vectorScore: number;
  finalScore: number;
}

/** Options for RAG retrieval */
export interface RAGSearchOptions {
  topK?: number;
  minScore?: number;
  kinds?: CodeChunk["kind"][];
  filePattern?: string;
  candidateMultiplier?: number;
}

/** Configuration for context window budget */
export interface ContextBudget {
  maxTokens: number;
  truncationStrategy: "drop_lowest" | "truncate_content";
  contextLines: number;
}

/** Embedding provider contract */
export interface IEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage: { totalTokens: number };
}

/** Vector store contract */
export interface IVectorStore {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  upsert(entries: VectorEntry[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  removeByFile(filePath: string): Promise<void>;
  search(queryVector: number[], topK: number): Promise<VectorSearchHit[]>;
  count(): number;
  has(id: string): boolean;
  getFileChunkIds(filePath: string): string[];
}

export interface VectorEntry {
  id: string;
  vector: number[];
  chunk: CodeChunk;
}

export interface VectorSearchHit {
  chunk: CodeChunk;
  score: number;
}

/** RAG pipeline contract */
export interface IRAGPipeline {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  indexFile(filePath: string, content: string): Promise<number>;
  removeFile(filePath: string): Promise<void>;
  indexProject(projectPath: string): Promise<IndexingStats>;
  search(query: string, options?: RAGSearchOptions): Promise<RAGSearchResult[]>;
  formatContext(results: RAGSearchResult[], budget?: ContextBudget): string;
  getStats(): IndexingStats;
}

export interface IndexingStats {
  totalFiles: number;
  totalChunks: number;
  indexedAt: string;
  durationMs: number;
  changedFiles?: number;
}
