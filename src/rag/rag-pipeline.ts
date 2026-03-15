import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import { glob } from "glob";
import type {
  IRAGPipeline,
  IEmbeddingProvider,
  IVectorStore,
  SearchOptions,
  SearchResult,
  RAGSearchResult,
  ContextBudget,
  IndexingStats,
  VectorEntry,
} from "./rag.interface.js";
import { isCodeChunk } from "./rag.interface.js";
import { createBrand } from "../types/index.js";
import { chunkCSharpFile } from "./chunker.js";
import { rerankResults } from "./reranker.js";
import { getLogger } from "../utils/logger.js";
import { FileVectorStore } from "./vector-store.js";
import { createHNSWVectorStore, type IHNSWVectorStore } from "./hnsw/hnsw-vector-store.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_CANDIDATE_MULTIPLIER = 3;

const DEFAULT_BUDGET: ContextBudget = {
  maxTokens: 4000,
  truncationStrategy: "drop_lowest",
  contextLines: 2,
};

/** 16-char hex SHA-256 digest of content. */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

export interface RAGPipelineConfig {
  /** Use HNSW index for vector search (default: true) */
  useHNSW?: boolean;
  /** HNSW configuration options */
  hnswConfig?: {
    M?: number;
    efConstruction?: number;
    efSearch?: number;
    maxElements?: number;
  };
  /** Force migration from legacy format */
  forceMigration?: boolean;
}

export class RAGPipeline implements IRAGPipeline {
  private readonly embeddingProvider: IEmbeddingProvider;
  private readonly vectorStore: IVectorStore;
  private useHNSW: boolean;
  private hnswStore?: IHNSWVectorStore;
  private legacyStore?: FileVectorStore;

  /** filePath → content hash of the last indexed version */
  private fileHashes: Map<string, string> = new Map();

  private stats: IndexingStats = {
    totalFiles: 0,
    totalChunks: 0,
    indexedAt: createBrand(Date.now(), "TimestampMs" as const),
    durationMs: createBrand(0, "DurationMs" as const),
    changedFiles: 0,
    errors: [],
  };

  private config: RAGPipelineConfig;

  constructor(
    embeddingProvider: IEmbeddingProvider, 
    vectorStore: IVectorStore,
    config: RAGPipelineConfig = {}
  ) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.config = {
      useHNSW: true,
      ...config,
    };
    this.useHNSW = this.config.useHNSW ?? true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // Check if we should use HNSW
    if (this.useHNSW && this.vectorStore instanceof FileVectorStore) {
      const storePath = this.getStorePath();
      
      if (storePath) {
        await this.initializeHNSW(storePath);
      } else {
        // Fall back to provided vector store
        await this.vectorStore.initialize();
      }
    } else {
      await this.vectorStore.initialize();
    }
  }

  private getStorePath(): string | null {
    // Try to extract path from FileVectorStore
    // This is a bit hacky but necessary for migration
    const store = this.vectorStore as unknown as { storePath?: string };
    return store.storePath ?? null;
  }

  private async initializeHNSW(storePath: string): Promise<void> {
    try {
      const hnswPath = join(storePath, "hnsw");
      const legacyVectorsPath = join(storePath, "vectors.bin");
      const legacyChunksPath = join(storePath, "chunks.json");
      const hnswIndexPath = join(hnswPath, "hnsw.index");

      // Check if HNSW index exists
      const hnswExists = existsSync(hnswIndexPath);
      // Check if legacy format exists
      const legacyExists = existsSync(legacyVectorsPath) && existsSync(legacyChunksPath);

      if (hnswExists) {
        // Use existing HNSW index
        getLogger().info("[RAGPipeline] Loading existing HNSW index");
        this.hnswStore = await createHNSWVectorStore(hnswPath, {
          dimensions: this.embeddingProvider.dimensions,
          maxElements: this.config.hnswConfig?.maxElements ?? 100000,
          M: this.config.hnswConfig?.M ?? 16,
          efConstruction: this.config.hnswConfig?.efConstruction ?? 200,
          efSearch: this.config.hnswConfig?.efSearch ?? 128,
          metric: "cosine",
        });
      } else if (legacyExists || this.config.forceMigration) {
        // Migrate from legacy format
        getLogger().info("[RAGPipeline] Migrating to HNSW index");
        this.hnswStore = await createHNSWVectorStore(hnswPath, {
          dimensions: this.embeddingProvider.dimensions,
          maxElements: this.config.hnswConfig?.maxElements ?? 100000,
          M: this.config.hnswConfig?.M ?? 16,
          efConstruction: this.config.hnswConfig?.efConstruction ?? 200,
          efSearch: this.config.hnswConfig?.efSearch ?? 128,
          metric: "cosine",
        });
        
        // Migration is handled automatically in HNSWVectorStore.initialize()
      } else {
        // Create new HNSW index
        getLogger().info("[RAGPipeline] Creating new HNSW index");
        this.hnswStore = await createHNSWVectorStore(hnswPath, {
          dimensions: this.embeddingProvider.dimensions,
          maxElements: this.config.hnswConfig?.maxElements ?? 100000,
          M: this.config.hnswConfig?.M ?? 16,
          efConstruction: this.config.hnswConfig?.efConstruction ?? 200,
          efSearch: this.config.hnswConfig?.efSearch ?? 128,
          metric: "cosine",
        });
      }

      // Keep legacy store as fallback
      this.legacyStore = this.vectorStore as FileVectorStore;
      await this.legacyStore.initialize();

      getLogger().info("[RAGPipeline] HNSW initialized", {
        dimensions: this.embeddingProvider.dimensions,
        storePath: hnswPath,
      });
    } catch (error) {
      getLogger().warn("[RAGPipeline] HNSW initialization failed, falling back to legacy store", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.useHNSW = false;
      await this.vectorStore.initialize();
    }
  }

  async shutdown(): Promise<void> {
    if (this.hnswStore) {
      await this.hnswStore.shutdown();
    }
    if (this.legacyStore) {
      await this.legacyStore.shutdown();
    }
    if (!this.hnswStore && !this.legacyStore) {
      await this.vectorStore.shutdown();
    }
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  async indexFile(filePath: string, content: string): Promise<number> {
    const contentHash = hashContent(content);

    // Skip unchanged files.
    if (this.fileHashes.get(filePath) === contentHash) {
      return 0;
    }

    const chunks = chunkCSharpFile(filePath, content);
    if (chunks.length === 0) {
      this.fileHashes.set(filePath, contentHash);
      return 0;
    }

    // Remove stale vectors for this file before re-indexing.
    await this.removeByFile(filePath);

    // Embed all chunk contents in a single batch.
    const texts = chunks.map((c) => c.content);
    const embeddingResult = await this.embeddingProvider.embed(texts);

    const entries: VectorEntry[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: embeddingResult.embeddings[i]!,
      chunk,
      addedAt: Date.now(),
      accessCount: 0,
    }));

    // Upsert to both stores for consistency
    if (this.hnswStore) {
      await this.hnswStore.upsert(entries);
    }
    if (this.legacyStore) {
      await this.legacyStore.upsert(entries);
    }
    if (!this.hnswStore && !this.legacyStore) {
      await this.vectorStore.upsert(entries);
    }
    
    this.fileHashes.set(filePath, contentHash);

    return chunks.length;
  }

  async removeFile(filePath: string): Promise<void> {
    await this.removeByFile(filePath);
    this.fileHashes.delete(filePath);
  }

  private async removeByFile(filePath: string): Promise<void> {
    if (this.hnswStore) {
      await this.hnswStore.removeByFile(filePath);
    }
    if (this.legacyStore) {
      await this.legacyStore.removeByFile(filePath);
    }
    if (!this.hnswStore && !this.legacyStore) {
      await this.vectorStore.removeByFile(filePath);
    }
  }

  async indexProject(projectPath: string): Promise<IndexingStats> {
    const startTime = Date.now();
    const logger = getLogger();

    const files = await glob("**/*.cs", {
      cwd: projectPath,
      absolute: true,
      ignore: ["**/Library/**", "**/Temp/**", "**/node_modules/**"],
    });

    logger.info("[RAGPipeline] Indexing project", {
      projectPath,
      fileCount: files.length,
    });

    let changedFiles = 0;
    const errors: Array<{ filePath: string; error: string }> = [];

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf8");
        const indexed = await this.indexFile(filePath, content);
        if (indexed > 0) {
          changedFiles++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn("[RAGPipeline] Failed to index file", { filePath, error: errorMsg });
        errors.push({ filePath, error: errorMsg });
      }
    }

    // Get count from appropriate store
    const chunkCount = this.hnswStore?.count() ?? 
                       this.legacyStore?.count() ?? 
                       this.vectorStore.count();

    this.stats = {
      totalFiles: files.length,
      totalChunks: chunkCount,
      indexedAt: createBrand(Date.now(), "TimestampMs" as const),
      durationMs: createBrand(Date.now() - startTime, "DurationMs" as const),
      changedFiles,
      errors,
    };

    logger.info("[RAGPipeline] Indexing complete", this.stats);
    return this.stats;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK ?? DEFAULT_TOP_K;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
    const candidateMultiplier = options?.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;

    // Use pre-computed embedding if provided, otherwise embed the query.
    let queryVector: number[];
    if (options?.queryEmbedding) {
      queryVector = options.queryEmbedding;
    } else {
      const embeddingResult = await this.embeddingProvider.embed([query]);
      queryVector = embeddingResult.embeddings[0]!;
    }

    // Determine which store to use for search
    const store = this.hnswStore ?? this.vectorStore;

    // Retrieve an oversized candidate set to allow filtering and reranking.
    const candidates = await store.search(
      queryVector,
      topK * candidateMultiplier
    );

    // Optional pre-filters.
    const filtered = candidates.filter((hit) => {
      if (options?.kinds && !options.kinds.includes(hit.chunk.kind)) {
        return false;
      }
      if (options?.filePattern) {
        const rel = relative(process.cwd(), hit.chunk.filePath);
        if (!rel.includes(options.filePattern)) {
          return false;
        }
      }
      return true;
    });

    // Convert to RAGSearchResult format
    const searchResults: RAGSearchResult[] = filtered.map(hit => ({
      chunk: hit.chunk,
      vectorScore: hit.score,
      finalScore: hit.score,
    }));

    // Rerank.
    const reranked = rerankResults(searchResults, query);

    // Apply minimum score threshold and slice to topK.
    return reranked.filter((r) => r.finalScore >= minScore).slice(0, topK);
  }

  // ---------------------------------------------------------------------------
  // Context formatting
  // ---------------------------------------------------------------------------

  formatContext(results: SearchResult[], budget?: ContextBudget): string {
    if (results.length === 0) return "";

    const b: ContextBudget = { ...DEFAULT_BUDGET, ...budget };
    const charBudget = b.maxTokens * 4;

    // Build chunks to include, respecting the character budget.
    const toInclude: RAGSearchResult[] = [];
    let usedChars = 0;

    if (b.truncationStrategy === "drop_lowest") {
      // Results arrive sorted by finalScore descending; iterate in order and
      // stop when the budget is exhausted.
      for (const result of results) {
        const chunkChars = result.chunk.content.length;
        if (usedChars + chunkChars > charBudget) break;
        toInclude.push(result);
        usedChars += chunkChars;
      }
    } else {
      // truncate_content: include all chunks but truncate the last one.
      for (const result of results) {
        const remaining = charBudget - usedChars;
        if (remaining <= 0) break;
        if (result.chunk.content.length <= remaining) {
          toInclude.push(result);
          usedChars += result.chunk.content.length;
        } else {
          // Truncate the content of this chunk to fit the remaining budget.
          const truncated: RAGSearchResult = {
            ...result,
            chunk: {
              ...result.chunk,
              content: result.chunk.content.slice(0, remaining),
            },
          };
          toInclude.push(truncated);
          break;
        }
      }
    }

    const sections = toInclude.map((result) => {
      const { chunk, finalScore } = result;
      // Only CodeChunk has line numbers and symbol
      const location = isCodeChunk(chunk) 
        ? `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
        : chunk.filePath;
      const symbolLine = isCodeChunk(chunk) && chunk.symbol ? ` · ${chunk.symbol}` : "";
      const header = `### ${chunk.kind}${symbolLine} (${location}) [score: ${finalScore.toFixed(3)}]`;
      return `${header}\n\`\`\`csharp\n${chunk.content}\n\`\`\``;
    });

    return sections.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): IndexingStats {
    return { ...this.stats };
  }

  /**
   * Get HNSW statistics if HNSW is enabled
   */
  getHNSWStats(): import("./hnsw/hnsw-vector-store.js").HNSWStats | null {
    if (!this.hnswStore) return null;
    return this.hnswStore.getHNSWStats();
  }

  /**
   * Check if HNSW is being used
   */
  isUsingHNSW(): boolean {
    return this.useHNSW && !!this.hnswStore;
  }
}
