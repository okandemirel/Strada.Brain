/**
 * Documentation RAG Pipeline
 *
 * Indexes framework documentation (markdown, XML docs, examples) into a
 * separate HNSW store.  Used by CompositeRAGPipeline for framework-aware search.
 */

import { readFile } from "node:fs/promises";
import { basename, sep } from "node:path";
import { glob } from "glob";
import { computeContentHash } from "../chunker.js";
import type {
  IEmbeddingProvider,
  IVectorStore,
  VectorSearchHit,
  VectorEntry,
} from "../rag.interface.js";
import { createBrand } from "../../types/index.js";
import type { FilePath, TimestampMs } from "../../types/index.js";
import type {
  FrameworkDocChunk,
  PackageRoot,
  DocSourceType,
} from "./doc-rag.interface.js";
import { chunkMarkdown, chunkXmlDocs, chunkCSharpExample } from "./doc-chunker.js";
import { getLoggerSafe } from "../../utils/logger.js";

/**
 * What "already indexed" compares: the content AND the package version, since
 * the chunk ids embed the version and an upgrade must re-key them.
 */
function sourceHash(pkg: PackageRoot, content: string): string {
  return `${pkg.version}:${computeContentHash(content)}`;
}

export class DocRAGPipeline {
  private readonly embeddingProvider: IEmbeddingProvider;
  private readonly vectorStore: IVectorStore;
  private fileHashes = new Map<string, string>();
  /** Chunk ids each source produced when last indexed, keyed like fileHashes. */
  private chunkIdsByKey = new Map<string, string[]>();
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

    await this.removeStaleChunks(pkg, new Set([...mdFiles, ...csFiles, ...exampleFiles]));

    logger?.debug(`Doc RAG: indexed ${totalChunks} chunks from ${pkg.name}`);
    this.indexedChunkCount += totalChunks;
    return totalChunks;
  }

  /**
   * Remove this package's chunks that no current source produces (MEM-12):
   * sections a shrunk file lost, every chunk of an older package version (the
   * chunk ids embed the version, so an upgrade re-keys them all), and chunks
   * of files that are gone. The store persists across restarts, so it is
   * asked what it holds rather than trusting this process's memory.
   */
  private async removeStaleChunks(pkg: PackageRoot, seenFiles: Set<string>): Promise<void> {
    const prefix = pkg.path.endsWith(sep) ? pkg.path : pkg.path + sep;
    const files = new Set<string>(seenFiles);
    for (const f of this.vectorStore.listIndexedFiles?.() ?? []) {
      if (f.filePath.startsWith(prefix)) files.add(f.filePath);
    }
    const stale: string[] = [];
    for (const filePath of files) {
      const live = new Set([
        ...(seenFiles.has(filePath) ? this.chunkIdsByKey.get(filePath) ?? [] : []),
        ...(seenFiles.has(filePath) ? this.chunkIdsByKey.get(`xml:${filePath}`) ?? [] : []),
      ]);
      for (const id of this.vectorStore.getFileChunkIds(filePath as FilePath)) {
        if (!live.has(id)) stale.push(id);
      }
    }
    if (stale.length > 0) await this.vectorStore.remove(stale);
  }

  /**
   * Embed and store one source's chunks, then record it as indexed. The hash
   * is recorded only after the store succeeded: recording it first meant an
   * embedding failure left the file marked done and never retried (MEM-12).
   */
  private async storeSourceChunks(key: string, hash: string, chunks: FrameworkDocChunk[]): Promise<void> {
    await this.embedAndStore(chunks);
    this.chunkIdsByKey.set(key, chunks.map((c) => c.id));
    this.fileHashes.set(key, hash);
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
    const hash = sourceHash(pkg, content);
    if (this.fileHashes.get(filePath) === hash) return 0;

    const name = basename(filePath).toLowerCase();
    const docSource: DocSourceType =
      name === "readme.md"
        ? "framework_readme"
        : name === "changelog.md"
          ? "framework_changelog"
          : "framework_docs";

    const chunks = chunkMarkdown(content, filePath, pkg, docSource);
    await this.storeSourceChunks(filePath, hash, chunks);
    return chunks.length;
  }

  private async indexXmlDocFile(filePath: string, pkg: PackageRoot): Promise<number> {
    const content = await readFile(filePath, "utf-8");

    const xmlHashKey = `xml:${filePath}`;
    // Only process files that contain XML doc comments; one that no longer
    // has any produces no chunks, and the package sweep drops its old ones.
    if (!content.includes("/// <summary>")) {
      this.chunkIdsByKey.delete(xmlHashKey);
      this.fileHashes.delete(xmlHashKey);
      return 0;
    }

    const hash = sourceHash(pkg, content);
    if (this.fileHashes.get(xmlHashKey) === hash) return 0;

    const chunks = chunkXmlDocs(content, filePath, pkg);
    await this.storeSourceChunks(xmlHashKey, hash, chunks);
    return chunks.length;
  }

  private async indexExampleFile(filePath: string, pkg: PackageRoot): Promise<number> {
    const content = await readFile(filePath, "utf-8");
    const hash = sourceHash(pkg, content);
    if (this.fileHashes.get(filePath) === hash) return 0;

    const chunks = chunkCSharpExample(content, filePath, pkg);
    await this.storeSourceChunks(filePath, hash, chunks);
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
