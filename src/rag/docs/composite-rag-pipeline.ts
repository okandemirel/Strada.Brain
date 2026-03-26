/**
 * Composite RAG Pipeline
 *
 * Implements IRAGPipeline by delegating to both the code RAGPipeline and
 * DocRAGPipeline, then merging results with framework-aware reranking.
 */

import type {
  IRAGPipeline,
  IEmbeddingProvider,
  SearchOptions,
  SearchResult,
  ContextBudget,
  IndexingStats,
  IndexingProgress,
  VectorSearchHit,
} from "../rag.interface.js";
import {
  estimateTokens,
  isDocumentationChunk,
  isCodeChunk,
} from "../rag.interface.js";
import type { RAGPipeline } from "../rag-pipeline.js";
import type { DocRAGPipeline } from "./doc-rag-pipeline.js";
import type { FrameworkSearchOptions, PackageRoot } from "./doc-rag.interface.js";
import { isFrameworkDocChunk } from "./doc-rag.interface.js";
import { rerankWithFrameworkPriority } from "./framework-reranker.js";

const DEFAULT_DOC_TOP_K = 5;
const DEFAULT_CODE_TOP_K = 8;

export class CompositeRAGPipeline implements IRAGPipeline {
  constructor(
    private readonly codePipeline: RAGPipeline,
    private readonly docPipeline: DocRAGPipeline,
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly packageRoots: PackageRoot[],
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await Promise.all([this.codePipeline.initialize(), this.docPipeline.initialize()]);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.codePipeline.shutdown(), this.docPipeline.shutdown()]);
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  async indexFile(filePath: string, content: string): Promise<number> {
    return this.codePipeline.indexFile(filePath, content);
  }

  async removeFile(filePath: string): Promise<void> {
    return this.codePipeline.removeFile(filePath);
  }

  async indexProject(
    projectPath: string,
    _options?: { onProgress?: (progress: IndexingProgress) => void; signal?: AbortSignal },
  ): Promise<IndexingStats> {
    // Index code files via code pipeline
    const codeStats = await this.codePipeline.indexProject(projectPath);

    // Index documentation from framework package roots (non-fatal)
    for (const pkg of this.packageRoots) {
      try {
        await this.docPipeline.indexPackage(pkg);
      } catch {
        // Doc indexing failure should never block code indexing
      }
    }

    return codeStats;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const fwOptions = options as FrameworkSearchOptions | undefined;
    const topK = options?.topK ?? DEFAULT_CODE_TOP_K;

    const searchCode = !fwOptions?.frameworkOnly;
    const searchDocs = !fwOptions?.projectOnly;

    // Embed the query once, reuse for both pipelines
    let queryEmbedding: number[] | undefined;
    if (options?.queryEmbedding) {
      queryEmbedding = options.queryEmbedding;
    } else {
      try {
        const embResult = await this.embeddingProvider.embed([query]);
        queryEmbedding = embResult.embeddings[0] as number[] | undefined;
      } catch {
        // Fallback: delegate entirely to code pipeline
        return this.codePipeline.search(query, options);
      }
    }

    if (!queryEmbedding || queryEmbedding.length === 0) {
      return this.codePipeline.search(query, options);
    }

    // Collect all hits as VectorSearchHit for the reranker
    const mergedHits: VectorSearchHit[] = [];

    if (searchCode) {
      const codeResults = await this.codePipeline.search(query, {
        ...options,
        queryEmbedding,
        topK: topK * 2,
      });
      // Convert SearchResult -> VectorSearchHit for uniform reranking
      for (const r of codeResults) {
        mergedHits.push({
          id: r.chunk.id,
          chunk: r.chunk,
          score: r.vectorScore,
        });
      }
    }

    if (searchDocs) {
      const docTopK = fwOptions?.frameworkOnly ? topK : DEFAULT_DOC_TOP_K;
      const docHits = await this.docPipeline.search(queryEmbedding, docTopK);
      mergedHits.push(...docHits);
    }

    if (mergedHits.length === 0) return [];

    // Rerank with framework priority and return top-K
    const reranked = rerankWithFrameworkPriority(query, mergedHits);
    return reranked.slice(0, topK);
  }

  // ---------------------------------------------------------------------------
  // Context formatting
  // ---------------------------------------------------------------------------

  formatContext(results: SearchResult[], budget?: ContextBudget): string {
    const maxTokens = budget?.maxTokens ?? 4000;
    const lines: string[] = [];
    let tokens = 0;

    for (const result of results) {
      const chunk = result.chunk;
      let formatted: string;

      if (isDocumentationChunk(chunk)) {
        const title = chunk.title ? `[${chunk.title}]` : "";
        const pkg = isFrameworkDocChunk(chunk) ? ` (${chunk.packageName})` : "";
        formatted = `// Doc ${title}${pkg} — ${chunk.filePath}\n${chunk.content}`;
      } else if (isCodeChunk(chunk)) {
        const symbol = chunk.symbol ? `: ${chunk.symbol}` : "";
        formatted = `// ${chunk.kind}${symbol} (${chunk.filePath}:${chunk.startLine})\n\`\`\`csharp\n${chunk.content}\n\`\`\``;
      } else {
        formatted = `// (${chunk.filePath})\n${chunk.content}`;
      }

      const chunkTokens = estimateTokens(formatted);
      if (tokens + chunkTokens > maxTokens) break;

      lines.push(formatted);
      tokens += chunkTokens;
    }

    return lines.join("\n\n---\n\n");
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): IndexingStats {
    return this.codePipeline.getStats();
  }
}
