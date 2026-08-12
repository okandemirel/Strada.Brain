import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { IEmbeddingProvider, EmbeddingBatch } from "../rag.interface.js";
import { getLogger } from "../../utils/logger.js";
import { LRUCache } from "../../common/lru-cache.js";
import {
  decodeEmbeddingCache,
  encodeEmbeddingCache,
  type EmbeddingCachePayload,
} from "./embedding-cache-codec.js";

const DEFAULT_MAX_CACHE_SIZE = 10_000;
const CACHE_FILENAME = "embedding-cache.bin";
/** Pre-binary filename, still read once so an upgrade keeps its warm cache. */
const LEGACY_CACHE_FILENAME = "embedding-cache.json";

interface PersistedCache {
  version: number;
  providerName: string;
  dimensions: number;
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

    const logger = getLogger();
    const persisted = await this.readPersisted();
    if (!persisted) return;

    // Invalidate cache if provider or dimensions changed (model swap)
    if (persisted.providerName !== this.inner.name || persisted.dimensions !== this.inner.dimensions) {
      logger.info("EmbeddingCache: provider/dimensions mismatch, discarding stale cache", {
        cachedProvider: persisted.providerName,
        currentProvider: this.inner.name,
        cachedDimensions: persisted.dimensions,
        currentDimensions: this.inner.dimensions,
      });
      return;
    }
    for (const { key, embedding } of persisted.entries) {
      if (this.cache.size >= this.maxCacheSize) break;
      this.cache.set(key, embedding);
    }
    logger.debug("EmbeddingCache: loaded from disk", {
      entries: this.cache.size,
      path: this.persistPath,
    });
  }

  /**
   * Reads the binary cache, falling back to the pre-binary JSON file so an
   * upgrade does not throw away a warm cache. Returns null when neither is
   * present or usable — the cache is a pure optimisation, so an unreadable
   * file costs a re-embed, never correctness.
   */
  private async readPersisted(): Promise<EmbeddingCachePayload | null> {
    const logger = getLogger();
    const binaryPath = join(this.persistPath!, CACHE_FILENAME);

    try {
      const decoded = decodeEmbeddingCache(await readFile(binaryPath));
      if (decoded) return decoded;
      logger.debug("EmbeddingCache: cache file failed to decode, ignoring", { path: binaryPath });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug("EmbeddingCache: could not load cache file", {
          path: binaryPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }

    const legacyPath = join(this.persistPath!, LEGACY_CACHE_FILENAME);
    try {
      const parsed = JSON.parse(await readFile(legacyPath, "utf8")) as PersistedCache;
      // The next shutdown writes the binary form; the JSON file is left in
      // place rather than deleted, so a downgrade still finds it.
      this.dirty = true;
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug("EmbeddingCache: could not load legacy cache file", {
          path: legacyPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
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
      const encoded = encodeEmbeddingCache({
        providerName: this.inner.name,
        dimensions: this.inner.dimensions,
        entries,
      });
      await writeFile(filePath, encoded);
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
      // Guard against a provider returning a short/misaligned batch — caching
      // result.embeddings[j] when it is undefined poisons the cache, and the
      // final `keys.map((k) => cache.get(k)!)` then hands undefined vectors
      // downstream (the `!` lies). Fail loudly instead.
      if (result.embeddings.length !== uncachedTexts.length) {
        throw new Error(
          `EmbeddingCache: provider returned ${result.embeddings.length} embeddings for ${uncachedTexts.length} texts`,
        );
      }
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
