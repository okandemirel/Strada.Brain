import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { IEmbeddingProvider, EmbeddingBatch } from "../rag.interface.js";
import { getLogger } from "../../utils/logger.js";
import { LRUCache } from "../../common/lru-cache.js";

const DEFAULT_MAX_CACHE_SIZE = 10_000;
const CACHE_FILENAME = "embedding-cache.json";

interface PersistedCache {
  version: number;
  entries: Array<{ key: string; embedding: number[] }>;
}

interface CachedEmbeddingProviderOptions {
  maxCacheSize?: number;
  persistPath?: string;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  dirty: boolean;
  persistPath: string | undefined;
}

export class CachedEmbeddingProvider implements IEmbeddingProvider {
  get name(): string {
    return this.inner.name;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  private readonly inner: IEmbeddingProvider;
  private readonly maxCacheSize: number;
  private readonly persistPath: string | undefined;

  private readonly cache: LRUCache<string, number[]>;
  private dirty = false;
  private hits = 0;
  private misses = 0;

  constructor(
    inner: IEmbeddingProvider,
    opts: CachedEmbeddingProviderOptions = {}
  ) {
    this.inner = inner;
    this.maxCacheSize = opts.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.persistPath = opts.persistPath;
    this.cache = new LRUCache<string, number[]>(this.maxCacheSize);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (!this.persistPath) return;

    const filePath = join(this.persistPath, CACHE_FILENAME);
    const logger = getLogger();

    try {
      const raw = await readFile(filePath, "utf8");
      const persisted = JSON.parse(raw) as PersistedCache;
      for (const { key, embedding } of persisted.entries) {
        if (this.cache.size >= this.maxCacheSize) break;
        this.cache.set(key, embedding);
      }
      logger.debug("EmbeddingCache: loaded from disk", {
        entries: this.cache.size,
        path: filePath,
      });
    } catch (err) {
      // Missing file or parse failure is non-fatal on first run
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.debug("EmbeddingCache: could not load cache file", {
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.persistPath || !this.dirty) return;

    const logger = getLogger();
    const filePath = join(this.persistPath, CACHE_FILENAME);

    try {
      await mkdir(this.persistPath, { recursive: true });
      const entries = Array.from(this.cache.entries()).map(([key, embedding]) => ({
        key,
        embedding,
      }));
      const persisted: PersistedCache = { version: 1, entries };
      await writeFile(filePath, JSON.stringify(persisted), "utf8");
      this.dirty = false;
      logger.debug("EmbeddingCache: persisted to disk", {
        entries: entries.length,
        path: filePath,
      });
    } catch (err) {
      logger.debug("EmbeddingCache: failed to persist cache", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // IEmbeddingProvider
  // ---------------------------------------------------------------------------

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    if (texts.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0 } };
    }

    const logger = getLogger();

    // Determine which texts are already cached
    const keys = texts.map((t) => this.cacheKey(t));
    const uncachedIndices: number[] = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (this.cache.has(key)) {
        this.hits++;
      } else {
        this.misses++;
        uncachedIndices.push(i);
      }
    }

    logger.debug("EmbeddingCache: embed called", {
      total: texts.length,
      cached: texts.length - uncachedIndices.length,
      uncached: uncachedIndices.length,
    });

    let totalTokens = 0;

    if (uncachedIndices.length > 0) {
      const uncachedTexts = uncachedIndices.map((i) => texts[i]!);
      const result = await this.inner.embed(uncachedTexts);
      totalTokens = result.usage.totalTokens;

      for (let j = 0; j < uncachedIndices.length; j++) {
        const originalIdx = uncachedIndices[j]!;
        const key = keys[originalIdx]!;
        const embedding = result.embeddings[j]!;
        this.cache.set(key, embedding);
      }

      this.dirty = true;
    }

    // Assemble results in original order
    const embeddings = keys.map((key) => this.cache.get(key)!);

    return { embeddings, usage: { totalTokens } };
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getCacheStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hits: this.hits,
      misses: this.misses,
      dirty: this.dirty,
      persistPath: this.persistPath,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private cacheKey(text: string): string {
    return createHash("sha256")
      .update(this.inner.name)
      .update("\x00")
      .update(String(this.inner.dimensions))
      .update("\x00")
      .update(text)
      .digest("hex");
  }

}
