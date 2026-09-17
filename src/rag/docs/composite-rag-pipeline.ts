/**
 * Composite RAG Pipeline
 *
 * Implements IRAGPipeline by delegating to both the code RAGPipeline and
 * DocRAGPipeline, then merging results with framework-aware reranking.
 */

import type {
  FormattedContext,
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
const DEFAULT_MAX_TOKENS = 4000;
/**
 * Tokens reserved so every contributing source renders at least one span. Big
 * enough to carry a real excerpt (~600 characters), small enough that reserving
 * one per source cannot eat a normal budget.
 */
const GUARANTEED_SOURCE_TOKENS = 150;

/** What joins two spans in the prompt. Counted against the budget (round 10 #18). */
const SPAN_SEPARATOR = "\n\n---\n\n";

/** Which retrieval source a merged result came from. */
type ContextSource = "code" | "docs";

function sourceOf(result: SearchResult): ContextSource {
  return isDocumentationChunk(result.chunk) ? "docs" : "code";
}

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
    await Promise.allSettled([this.codePipeline.initialize(), this.docPipeline.initialize()]);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.codePipeline.shutdown(), this.docPipeline.shutdown()]);
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
    return this.formatContextWithSpans(results, budget).text;
  }

  /**
   * WHAT WAS SHOWN IS WHAT FIT — AND EVERY SOURCE THAT CONTRIBUTED SHOWS
   * SOMETHING. Two defects lived here (D48 / audit 05.F5): the budget loop broke
   * out silently, so callers reported spans the prompt never carried; and with a
   * single shared budget the code hits (bigger, and reranked first) could consume
   * all of it, so a framework doc hit the search counted as a contributor
   * rendered nothing at all. Each source present in the results now keeps a
   * reserved slice, and the returned lists say exactly what was rendered.
   */
  formatContextWithSpans(results: SearchResult[], budget?: ContextBudget): FormattedContext {
    if (results.length === 0) return { text: "", included: [], dropped: [] };

    const maxTokens = budget?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const sources = new Set(results.map(sourceOf));
    // Reserve one guaranteed slice per source beyond the first; the greedy pass
    // spends the rest in rank order.
    const guaranteedTokens = Math.max(
      1,
      Math.min(GUARANTEED_SOURCE_TOKENS, Math.floor(maxTokens / Math.max(1, sources.size))),
    );
    const greedyBudget = Math.max(0, maxTokens - guaranteedTokens * (sources.size - 1));

    const parts: string[] = [];
    const included: SearchResult[] = [];
    /** The ORIGINAL results behind the included list (entries may be clamped copies). */
    const shown = new Set<SearchResult>();
    // THE BUDGET IS A CEILING, SEPARATORS INCLUDED (Codex round 10 #18): the
    // joiner between spans was never counted, and the guarantee pass handed the
    // first missing source all the remaining room and then gave the next one a
    // slice there was no room for — 400 tokens asked, about 552 rendered.
    const separatorTokens = estimateTokens(SPAN_SEPARATOR);
    let tokens = 0;
    const costOf = (formatted: string): number =>
      estimateTokens(formatted) + (parts.length > 0 ? separatorTokens : 0);

    for (const result of results) {
      const formatted = renderSpan(result);
      if (tokens + costOf(formatted) > greedyBudget) break;

      tokens += costOf(formatted);
      parts.push(formatted);
      included.push(result);
      shown.add(result);
    }

    const missing = [...sources]
      .filter((source) => !included.some((result) => sourceOf(result) === source))
      .map((source) => ({ source, top: results.find((result) => sourceOf(result) === source) }))
      .filter((entry): entry is { source: ContextSource; top: SearchResult } => entry.top !== undefined);

    for (let i = 0; i < missing.length; i++) {
      const { top } = missing[i]!;
      // Share what is left with the sources still waiting, and never overrun: a
      // source that cannot fit at all stays in the dropped list, which is what
      // the caller reports.
      const remainingSources = missing.length - i;
      const free = maxTokens - tokens - (parts.length > 0 ? separatorTokens : 0);
      const room = Math.min(guaranteedTokens, Math.floor(Math.max(0, free) / remainingSources));
      if (room <= 0) continue;
      const clamped = clampToTokens(top, room);
      const formatted = renderSpan(clamped);
      if (tokens + costOf(formatted) > maxTokens) continue;

      tokens += costOf(formatted);
      parts.push(formatted);
      included.push(clamped);
      shown.add(top);
    }

    return {
      text: parts.join(SPAN_SEPARATOR),
      included,
      dropped: results.filter((result) => !shown.has(result)),
    };
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): IndexingStats {
    return this.codePipeline.getStats();
  }
}

/** One merged hit as it appears in the prompt. */
function renderSpan(result: SearchResult): string {
  const chunk = result.chunk;
  if (isDocumentationChunk(chunk)) {
    const title = chunk.title ? `[${chunk.title}]` : "";
    const pkg = isFrameworkDocChunk(chunk) ? ` (${chunk.packageName})` : "";
    return `// Doc ${title}${pkg} — ${chunk.filePath}\n${chunk.content}`;
  }
  if (isCodeChunk(chunk)) {
    const symbol = chunk.symbol ? `: ${chunk.symbol}` : "";
    return `// ${chunk.kind}${symbol} (${chunk.filePath}:${chunk.startLine})\n\`\`\`csharp\n${chunk.content}\n\`\`\``;
  }
  return `// (${chunk.filePath})\n${chunk.content}`;
}

/**
 * Clamp a span's CONTENT so its rendered form fits maxTokens. The returned
 * result carries the clamped content, because that is what the prompt shows.
 */
function clampToTokens(result: SearchResult, maxTokens: number): SearchResult {
  const rendered = renderSpan(result);
  if (estimateTokens(rendered) <= maxTokens) return result;

  const overheadChars = rendered.length - result.chunk.content.length;
  const allowedChars = Math.max(1, maxTokens * 4 - overheadChars);
  return {
    ...result,
    chunk: { ...result.chunk, content: result.chunk.content.slice(0, allowedChars) },
  };
}
