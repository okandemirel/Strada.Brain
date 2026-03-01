import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import { glob } from "glob";
import type {
  IRAGPipeline,
  IEmbeddingProvider,
  IVectorStore,
  RAGSearchOptions,
  RAGSearchResult,
  ContextBudget,
  IndexingStats,
  VectorEntry,
} from "./rag.interface.js";
import { chunkCSharpFile } from "./chunker.js";
import { rerankResults } from "./reranker.js";
import { getLogger } from "../utils/logger.js";

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

export class RAGPipeline implements IRAGPipeline {
  private readonly embeddingProvider: IEmbeddingProvider;
  private readonly vectorStore: IVectorStore;

  /** filePath → content hash of the last indexed version */
  private fileHashes: Map<string, string> = new Map();

  private stats: IndexingStats = {
    totalFiles: 0,
    totalChunks: 0,
    indexedAt: new Date().toISOString(),
    durationMs: 0,
  };

  constructor(embeddingProvider: IEmbeddingProvider, vectorStore: IVectorStore) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.vectorStore.initialize();
  }

  async shutdown(): Promise<void> {
    await this.vectorStore.shutdown();
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
    await this.vectorStore.removeByFile(filePath);

    // Embed all chunk contents in a single batch.
    const texts = chunks.map((c) => c.content);
    const embeddingResult = await this.embeddingProvider.embed(texts);

    const entries: VectorEntry[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: embeddingResult.embeddings[i]!,
      chunk,
    }));

    await this.vectorStore.upsert(entries);
    this.fileHashes.set(filePath, contentHash);

    return chunks.length;
  }

  async removeFile(filePath: string): Promise<void> {
    await this.vectorStore.removeByFile(filePath);
    this.fileHashes.delete(filePath);
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

    let totalChunks = 0;
    let changedFiles = 0;

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf8");
        const indexed = await this.indexFile(filePath, content);
        if (indexed > 0) {
          totalChunks += indexed;
          changedFiles++;
        }
      } catch (err) {
        logger.warn("[RAGPipeline] Failed to index file", { filePath, err });
      }
    }

    this.stats = {
      totalFiles: files.length,
      totalChunks: this.vectorStore.count(),
      indexedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      changedFiles,
    };

    logger.info("[RAGPipeline] Indexing complete", this.stats);
    return this.stats;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(query: string, options?: RAGSearchOptions): Promise<RAGSearchResult[]> {
    const topK = options?.topK ?? DEFAULT_TOP_K;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
    const candidateMultiplier = options?.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;

    // Embed the query.
    const embeddingResult = await this.embeddingProvider.embed([query]);
    const queryVector = embeddingResult.embeddings[0]!;

    // Retrieve an oversized candidate set to allow filtering and reranking.
    const candidates = await this.vectorStore.search(
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

    // Rerank.
    const reranked = rerankResults(filtered, query);

    // Apply minimum score threshold and slice to topK.
    return reranked.filter((r) => r.finalScore >= minScore).slice(0, topK);
  }

  // ---------------------------------------------------------------------------
  // Context formatting
  // ---------------------------------------------------------------------------

  formatContext(results: RAGSearchResult[], budget?: ContextBudget): string {
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
      const location = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
      const symbolLine = chunk.symbol ? ` · ${chunk.symbol}` : "";
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
}
