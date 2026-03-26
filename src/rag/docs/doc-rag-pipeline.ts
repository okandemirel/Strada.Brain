/**
 * Documentation RAG Pipeline
 *
 * Indexes framework documentation (markdown, XML docs, examples) into a
 * separate HNSW store.  Used by CompositeRAGPipeline for framework-aware search.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { glob } from "glob";
import { computeContentHash } from "../chunker.js";
import type {
  IEmbeddingProvider,
  IVectorStore,
  VectorSearchHit,
  VectorEntry,
} from "../rag.interface.js";
import { createBrand } from "../../types/index.js";
import type { TimestampMs } from "../../types/index.js";
import type {
  FrameworkDocChunk,
  PackageRoot,
  DocSourceType,
} from "./doc-rag.interface.js";
import { chunkMarkdown, chunkXmlDocs, chunkCSharpExample } from "./doc-chunker.js";
import { getLoggerSafe } from "../../utils/logger.js";

export class DocRAGPipeline {
  private readonly embeddingProvider: IEmbeddingProvider;
  private readonly vectorStore: IVectorStore;
  private fileHashes = new Map<string, string>();
  private indexedChunkCount = 0;

  constructor(embeddingProvider: IEmbeddingProvider, vectorStore: IVectorStore) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
  }

  async initialize(): Promise<void> {
    await this.vectorStore.initialize();
  }

  async shutdown(): Promise<void> {
    await this.vectorStore.shutdown();
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  /**
   * Index all documentation for a single package root.
   * Returns the number of chunks indexed.
   */
  async indexPackage(pkg: PackageRoot): Promise<number> {
    const logger = getLoggerSafe();
    let totalChunks = 0;

    // 1. Markdown files
    const mdFiles = await glob("**/*.md", {
      cwd: pkg.path,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    for (const filePath of mdFiles) {
      try {
        const indexed = await this.indexMarkdownFile(filePath, pkg);
        totalChunks += indexed;
      } catch (err) {
        logger?.debug(`Doc RAG: skipping ${filePath}: ${(err as Error).message}`);
      }
    }

    // 2. XML doc comments from C# source files
    const csFiles = await glob("**/*.cs", {
      cwd: pkg.path,
      absolute: true,
      ignore: ["**/Tests/**", "**/bin/**", "**/obj/**", "**/node_modules/**"],
    });

    for (const filePath of csFiles) {
      try {
        const indexed = await this.indexXmlDocFile(filePath, pkg);
        totalChunks += indexed;
      } catch (err) {
        logger?.debug(`Doc RAG XML: skipping ${filePath}: ${(err as Error).message}`);
      }
    }

    // 3. Example / sample files
    const exampleFiles = await glob("{**/Examples/**/*.cs,**/Samples/**/*.cs}", {
      cwd: pkg.path,
      absolute: true,
      ignore: ["**/bin/**", "**/obj/**"],
    });

    for (const filePath of exampleFiles) {
      try {
        const indexed = await this.indexExampleFile(filePath, pkg);
        totalChunks += indexed;
      } catch (err) {
        logger?.debug(`Doc RAG example: skipping ${filePath}: ${(err as Error).message}`);
      }
    }

    logger?.debug(`Doc RAG: indexed ${totalChunks} chunks from ${pkg.name}`);
    this.indexedChunkCount += totalChunks;
    return totalChunks;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Search documentation by pre-computed query embedding.
   */
  async search(queryEmbedding: number[], topK: number): Promise<VectorSearchHit[]> {
    return this.vectorStore.search(queryEmbedding as unknown as Parameters<typeof this.vectorStore.search>[0], topK);
  }

  /** Total chunks indexed across all packages so far. */
  get chunkCount(): number {
    return this.indexedChunkCount;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async indexMarkdownFile(filePath: string, pkg: PackageRoot): Promise<number> {
    const content = await readFile(filePath, "utf-8");
    const hash = computeContentHash(content);
    if (this.fileHashes.get(filePath) === hash) return 0;
    this.fileHashes.set(filePath, hash);

    const name = basename(filePath).toLowerCase();
    const docSource: DocSourceType =
      name === "readme.md"
        ? "framework_readme"
        : name === "changelog.md"
          ? "framework_changelog"
          : "framework_docs";

    const chunks = chunkMarkdown(content, filePath, pkg, docSource);
    await this.embedAndStore(chunks);
    return chunks.length;
  }

  private async indexXmlDocFile(filePath: string, pkg: PackageRoot): Promise<number> {
    const content = await readFile(filePath, "utf-8");

    // Only process files that contain XML doc comments
    if (!content.includes("/// <summary>")) return 0;

    const xmlHashKey = `xml:${filePath}`;
    const hash = computeContentHash(content);
    if (this.fileHashes.get(xmlHashKey) === hash) return 0;
    this.fileHashes.set(xmlHashKey, hash);

    const chunks = chunkXmlDocs(content, filePath, pkg);
    if (chunks.length === 0) return 0;

    await this.embedAndStore(chunks);
    return chunks.length;
  }

  private async indexExampleFile(filePath: string, pkg: PackageRoot): Promise<number> {
    const content = await readFile(filePath, "utf-8");
    const hash = computeContentHash(content);
    if (this.fileHashes.get(filePath) === hash) return 0;
    this.fileHashes.set(filePath, hash);

    const chunks = chunkCSharpExample(content, filePath, pkg);
    await this.embedAndStore(chunks);
    return chunks.length;
  }

  private async embedAndStore(chunks: FrameworkDocChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.content);
    const result = await this.embeddingProvider.embed(texts);

    const entries: VectorEntry[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = result.embeddings[i];
      if (!Array.isArray(vector) || vector.length === 0) continue;
      entries.push({
        id: chunks[i]!.id,
        vector: vector as unknown as VectorEntry['vector'],
        chunk: chunks[i] as unknown as VectorEntry['chunk'],
        addedAt: createBrand(Date.now(), "TimestampMs" as const) as TimestampMs,
        accessCount: 0,
      });
    }

    if (entries.length > 0) {
      await this.vectorStore.upsert(entries);
    }
  }
}
