/**
 * AgentDB HNSW / Vector Helpers
 *
 * Extracted from AgentDBMemory — standalone functions for HNSW indexing,
 * embedding generation, dimension mismatch handling, and hash-to-real migration.
 */

import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type {
  EmbeddingProvenance,
  UnifiedMemoryConfig,
  UnifiedMemoryEntry,
} from "./unified-memory.interface.js";
import {
  DEFAULT_PROVIDER_PROVENANCE,
  HISTOGRAM_PROVENANCE,
  UNKNOWN_PROVENANCE,
} from "./unified-memory.interface.js";
import type { HNSWConfig, HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import { createHNSWVectorStore, isHnswAvailable } from "../../rag/hnsw/hnsw-vector-store.js";
import type { VectorEntry } from "../../rag/rag.interface.js";
import type {
  TimestampMs,
  Vector,
} from "../../types/index.js";
import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try { return getLogger(); } catch { return console; }
}
import type { HnswWriteMutex } from "./hnsw-write-mutex.js";
import type { AgentDBSqliteContext } from "./agentdb-sqlite.js";
import {
  loadEntriesWithoutHnsw,
  persistEntry as sqlitePersistEntry,
  upsertEntryRow,
} from "./agentdb-sqlite.js";

// ---------------------------------------------------------------------------
// Context required by vector helpers
// ---------------------------------------------------------------------------

export interface AgentDBVectorContext extends AgentDBSqliteContext {
  readonly config: UnifiedMemoryConfig;
  hnswStore: HNSWVectorStore | undefined;
  readonly writeMutex: HnswWriteMutex;
  rebuildInProgress: boolean;
  tieringTimer: ReturnType<typeof setInterval> | null;
  tieringParams: { intervalMs: number; promotionThreshold: number; demotionTimeoutDays: number } | null;
  startAutoTiering(intervalMs: number, promotionThreshold: number, demotionTimeoutDays: number): void;
  stopAutoTiering(): void;
}

// ---------------------------------------------------------------------------
// VectorEntry conversion
// ---------------------------------------------------------------------------

/** Build a VectorEntry from a unified memory entry for HNSW indexing. */
export function toVectorEntry(entry: {
  id: string;
  content: string;
  chatId?: string;
  embedding: number[];
  createdAt: number;
  accessCount: number;
}): VectorEntry {
  return {
    id: entry.id,
    vector: entry.embedding,
    chunk: {
      id: entry.id,
      content: entry.content,
      contentHash: "",
      filePath: entry.chatId ?? "memory",
      indexedAt: entry.createdAt,
      kind: "class" as const,
      startLine: 0,
      endLine: 0,
      language: "typescript",
    },
    addedAt: entry.createdAt as TimestampMs,
    accessCount: entry.accessCount,
  };
}

// ---------------------------------------------------------------------------
// Embedding provenance (plan 0-B.9: audit 05.cap + Codex #18)
// ---------------------------------------------------------------------------
//
// Every vector records which embedder produced it. The HNSW store is the
// index of ONE provenance — `indexProvenance(config)` — and a vector of any
// other provenance never enters it and is never compared against it. A
// provider failure therefore yields a histogram vector that is stored on the
// entry (so the row is complete) but kept OUT of the provider index; the
// entry stays reachable through the TF-IDF text path only.
//
// Chosen over a second index because the retrieval context holds one
// hnswStore and one write mutex; a provenance gate at insert time plus a
// provenance check at search time is the smallest change that keeps the
// invariant with the existing store.

/** Provenance the configured provider stamps on its vectors. */
export function providerProvenance(config: UnifiedMemoryConfig): EmbeddingProvenance {
  return config.embeddingProviderId ?? DEFAULT_PROVIDER_PROVENANCE;
}

/**
 * Provenance the HNSW index holds. With a provider configured that is the
 * provider; with none, every vector is a histogram and the index is a
 * histogram index (consistent with itself, replaced when a provider arrives).
 */
export function indexProvenance(config: UnifiedMemoryConfig): EmbeddingProvenance {
  return config.embeddingProvider ? providerProvenance(config) : HISTOGRAM_PROVENANCE;
}

/** True when the entry's vector may enter / be compared in the HNSW index. */
export function canEnterIndex(
  config: UnifiedMemoryConfig,
  entry: { embedding?: readonly number[] | null; embeddingProvenance?: EmbeddingProvenance },
): boolean {
  if (!entry.embedding || entry.embedding.length !== config.dimensions) return false;
  return entry.embeddingProvenance === indexProvenance(config);
}

/**
 * Provenance for a legacy row that carries a vector but no provenance
 * (written before plan 0-B.9): hash-shaped vectors are histograms; anything
 * else is "unknown" (Codex round 6 #18) — it used to be stamped with the
 * CURRENT provider id, which put a vector of unknown origin into the provider
 * index. Unknown vectors never enter the index or a search until
 * `reEmbedHashEntries` re-embeds them.
 */
export function inferProvenance(
  _config: UnifiedMemoryConfig,
  embedding: readonly number[] | null | undefined,
): EmbeddingProvenance | undefined {
  if (!embedding || embedding.length === 0) return undefined;
  if (isHashBasedEmbedding("", embedding as number[])) return HISTOGRAM_PROVENANCE;
  return UNKNOWN_PROVENANCE;
}

/**
 * True when the stored vector must be re-embedded before it can serve the
 * provider index: histogram fallback, unknown origin (#18), or another
 * provider's vector (#17 — a model swap changes `embeddingProviderId`).
 */
export function needsReEmbedding(
  config: UnifiedMemoryConfig,
  entry: { content: string; embedding?: readonly number[] | null; embeddingProvenance?: EmbeddingProvenance },
): "histogram" | "unknown" | "foreign" | null {
  if (!entry.embedding || entry.embedding.length === 0) return null;
  const provenance = entry.embeddingProvenance ?? inferProvenance(config, entry.embedding);
  if (provenance === HISTOGRAM_PROVENANCE) return "histogram";
  if (provenance === UNKNOWN_PROVENANCE) return "unknown";
  if (provenance !== providerProvenance(config)) return "foreign";
  return null;
}

/** Vector + provenance pair returned by `embedWithProvenance`. */
export interface ProvenancedEmbedding {
  readonly embedding: Vector<number>;
  readonly provenance: EmbeddingProvenance;
}

/** Character-histogram fallback — not semantic; provenance "histogram". */
export function histogramEmbedding(config: UnifiedMemoryConfig, text: string): Vector<number> {
  const dimensions = config.dimensions;
  const embedding = new Array(dimensions).fill(0);

  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    embedding[i % dimensions]! += char / 255;
  }

  const magnitude = Math.sqrt(embedding.reduce((a: number, b: number) => a + b * b, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i]! /= magnitude;
    }
  }

  return embedding as Vector<number>;
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

/**
 * Embed `text` and say which embedder did it. Provider failure returns a
 * histogram vector stamped "histogram" — callers gate HNSW on the provenance.
 */
export async function embedWithProvenance(
  config: UnifiedMemoryConfig,
  text: string,
): Promise<ProvenancedEmbedding> {
  if (config.embeddingProvider) {
    try {
      const embedding = await config.embeddingProvider(text) as Vector<number>;
      return { embedding, provenance: providerProvenance(config) };
    } catch (error) {
      getLoggerSafe().warn(
        "[AgentDBMemory] Embedding provider failed — histogram vector stamped 'histogram', kept out of the provider index",
        { error: String(error) },
      );
    }
  }
  return { embedding: histogramEmbedding(config, text), provenance: HISTOGRAM_PROVENANCE };
}

/**
 * Generate an embedding using the configured provider, falling back to the
 * histogram. Kept for callers that only need the vector; anything that stores
 * or searches must use `embedWithProvenance` so the provenance travels.
 */
export async function generateEmbedding(
  config: UnifiedMemoryConfig,
  text: string,
): Promise<Vector<number>> {
  return (await embedWithProvenance(config, text)).embedding;
}

// ---------------------------------------------------------------------------
// Hash-based embedding detection
// ---------------------------------------------------------------------------

/**
 * Detect whether an embedding was produced by the hash-based fallback
 * rather than a real neural embedding provider.
 */
export function isHashBasedEmbedding(_content: string, embedding: number[]): boolean {
  if (!embedding || embedding.length === 0) return false;

  // Real neural embeddings from any transformer model contain negative
  // components. The hash-based fallback accumulates charCode/255 per
  // dimension bucket then L2-normalizes, producing vectors where every
  // component is >= 0.
  const isAllPositive = embedding.every((v) => v >= 0);
  if (!isAllPositive) return false;

  // Short content can produce all-positive neural embeddings by chance.
  // Hash embeddings have very low variance since they're accumulated charCode/255 values.
  // Real neural embeddings have significantly higher variance even when all positive.
  const mean = embedding.reduce((a, b) => a + b, 0) / embedding.length;
  const variance = embedding.reduce((a, b) => a + (b - mean) ** 2, 0) / embedding.length;
  return variance < 0.01;
}

// ---------------------------------------------------------------------------
// Opening the store
// ---------------------------------------------------------------------------

/** The HNSW store configuration AgentDB derives from its memory config. */
export function agentDbHnswConfig(config: UnifiedMemoryConfig): Partial<HNSWConfig> {
  return {
    dimensions: config.dimensions,
    maxElements: Object.values(config.maxEntriesPerTier).reduce((a, b) => a + b, 0),
    M: config.hnswParams.M,
    efConstruction: config.hnswParams.efConstruction,
    efSearch: config.hnswParams.efSearch,
    metric: "cosine",
    quantization: config.quantizationType,
  };
}

/**
 * Open AgentDB's HNSW store at `<dbPath>/hnsw`.
 *
 * For AgentDB the persisted index is only a cache: loadEntries always rebuilds
 * it from SQLite with replaceAll. A persisted index that cannot be opened with
 * the current configuration (most often one written for other embedding
 * dimensions after a provider switch, or a damaged file) is therefore
 * discarded and the store starts empty, instead of failing initialize() and
 * putting every AgentDB memory out of reach (MEM-2). When hnswlib-node itself
 * is missing there is nothing to reset, so that error still propagates.
 */
export async function openAgentDbHnswStore(
  dbPath: string,
  config: UnifiedMemoryConfig,
): Promise<HNSWVectorStore> {
  const vectorStorePath = join(dbPath, "hnsw");
  const hnswConfig = agentDbHnswConfig(config);
  try {
    return await createHNSWVectorStore(vectorStorePath, hnswConfig);
  } catch (error) {
    if (!isHnswAvailable() || !existsSync(vectorStorePath)) throw error;
    getLoggerSafe().warn(
      "[AgentDBMemory] Persisted HNSW index cannot be opened with the current configuration; discarding it (it is rebuilt from SQLite)",
      { path: vectorStorePath, dimensions: config.dimensions, error: String(error) },
    );
    rmSync(vectorStorePath, { recursive: true, force: true });
    return createHNSWVectorStore(vectorStorePath, hnswConfig);
  }
}

// ---------------------------------------------------------------------------
// Dimension mismatch detection
// ---------------------------------------------------------------------------

/**
 * Detect if the existing HNSW index was built with a different vector dimension
 * than the current config. If mismatch is found and an embedding provider is
 * available, triggers a full re-embed + index rebuild.
 */
export async function detectAndHandleDimensionMismatch(ctx: AgentDBVectorContext): Promise<void> {
  if (!ctx.hnswStore) return;

  try {
    // getHNSWStats may not exist if store is a partial mock or legacy implementation
    if (typeof ctx.hnswStore.getHNSWStats !== "function") return;

    const stats = ctx.hnswStore.getHNSWStats();
    const indexDimensions = stats.config.dimensions;
    const configDimensions = ctx.config.dimensions;

    // No mismatch or empty index — nothing to do
    if (indexDimensions === configDimensions || stats.elementCount === 0) {
      return;
    }

    getLoggerSafe().warn("[AgentDBMemory] HNSW dimension mismatch detected", {
      indexDimensions,
      configDimensions,
      existingElements: stats.elementCount,
    });

    if (!ctx.config.embeddingProvider) {
      getLoggerSafe().warn(
        "[AgentDBMemory] No embedding provider available — skipping HNSW rebuild. " +
        "Hash-based fallback will be used, but semantic search quality will be degraded.",
      );
      return;
    }

    await rebuildHnswIndex(ctx);
  } catch (error) {
    getLoggerSafe().warn("[AgentDBMemory] Dimension mismatch detection failed, continuing", {
      error: String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Full HNSW index rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild the HNSW index from scratch with the current config dimensions.
 * Re-embeds all in-memory entries via the configured embedding provider.
 */
export async function rebuildHnswIndex(ctx: AgentDBVectorContext): Promise<void> {
  if (ctx.rebuildInProgress) {
    getLoggerSafe().warn("[AgentDBMemory] HNSW rebuild already in progress, skipping");
    return;
  }
  ctx.rebuildInProgress = true;
  const wasTiering = ctx.tieringTimer !== null;
  ctx.stopAutoTiering();
  try {
    getLoggerSafe().info("[AgentDBMemory] Starting HNSW index rebuild with new dimensions", {
      dimensions: ctx.config.dimensions,
    });

    // Delete old HNSW index files so createHNSWVectorStore starts fresh
    const vectorStorePath = join(ctx.dbPath, "hnsw");
    try {
      rmSync(vectorStorePath, { recursive: true, force: true });
    } catch (e) {
      getLoggerSafe().warn("[AgentDBMemory] Failed to remove old HNSW index files", {
        error: String(e),
      });
    }

    // Recreate HNSW store with correct dimensions
    ctx.hnswStore = await createHNSWVectorStore(vectorStorePath, agentDbHnswConfig(ctx.config));
    // Gate the store's background compaction behind the shared write mutex (M1).
    // Optional: best-effort wiring, must not abort rebuild if the store lacks it.
    ctx.hnswStore.setWriteSerializer?.(ctx.writeMutex);

    // Load entries from SQLite (entries map may be empty at this point during init)
    const hadEntries = ctx.entries.size > 0;
    if (!hadEntries) {
      await loadEntriesWithoutHnsw(ctx);
    }

    const totalEntries = ctx.entries.size;
    if (totalEntries === 0) {
      getLoggerSafe().info("[AgentDBMemory] No entries to re-embed — rebuild complete");
      return;
    }

    let succeeded = 0;
    let failed = 0;
    const store = ctx.hnswStore;

    for (const entry of ctx.entries.values()) {
      try {
        // Re-embed the entry content — the provenance travels with the vector
        const { embedding: newEmbedding, provenance } = await embedWithProvenance(ctx.config, entry.content);
        (entry as unknown as { embedding: Vector<number>; embeddingProvenance: EmbeddingProvenance }).embedding = newEmbedding;
        (entry as unknown as { embeddingProvenance: EmbeddingProvenance }).embeddingProvenance = provenance;

        if (provenance !== indexProvenance(ctx.config)) {
          // Provider failed for this entry: the histogram vector stays on the
          // row (text path still serves it) but never enters the provider index.
          sqlitePersistEntry(ctx, entry);
          failed++;
          continue;
        }

        // Upsert into new HNSW index
        await ctx.writeMutex.withLock(() =>
          store.upsert([
            {
              id: entry.id as string,
              vector: newEmbedding,
              chunk: {
                id: entry.id as string,
                content: entry.content,
                contentHash: "",
                filePath: (entry.chatId as string) ?? "memory",
                indexedAt: entry.createdAt as TimestampMs,
                kind: "class" as const,
                startLine: 0,
                endLine: 0,
                language: "typescript",
              },
              addedAt: entry.createdAt as TimestampMs,
              accessCount: entry.accessCount,
            },
          ]),
        );

        // Persist updated embedding to SQLite
        sqlitePersistEntry(ctx, entry);

        succeeded++;

        // Log progress every 50 entries
        if (succeeded % 50 === 0 || succeeded === totalEntries) {
          getLoggerSafe().info(
            `[AgentDBMemory] Re-embedding ${succeeded}/${totalEntries} entries...`,
          );
        }
      } catch (entryError) {
        failed++;
        getLoggerSafe().warn("[AgentDBMemory] Failed to re-embed entry, skipping", {
          entryId: entry.id as string,
          error: String(entryError),
        });
      }
    }

    getLoggerSafe().info("[AgentDBMemory] HNSW index rebuild complete", {
      succeeded,
      failed,
      totalEntries,
      newDimensions: ctx.config.dimensions,
    });
  } finally {
    ctx.rebuildInProgress = false;
    if (wasTiering && ctx.tieringParams) {
      ctx.startAutoTiering(
        ctx.tieringParams.intervalMs,
        ctx.tieringParams.promotionThreshold,
        ctx.tieringParams.demotionTimeoutDays,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Hash-to-Real embedding migration
// ---------------------------------------------------------------------------

/** Outcome of one `reEmbedHashEntries` pass. Every count names what it measured. */
export interface ReEmbedResult {
  /** Hash-based entries whose real embedding was generated AND persisted. */
  migrated: number;
  /** Entries with an embedding that were scanned (0 when the pass could not run). */
  total: number;
  /** Entries left as they were: already real, provider failure, or persist failure. */
  skipped: number;
  /** Entries the hash-vector detector flagged this pass (migrated + failed). */
  hashDetected: number;
  /** Entries whose vector has no known embedder (Codex round 6 #18). */
  unknownDetected: number;
  /** Entries embedded by a different provider id than the configured one (Codex round 6 #17). */
  foreignDetected: number;
}

/** Rows per provider call when the provider accepts arrays (Codex round 7 #21). */
export const RE_EMBED_BATCH_SIZE = 64;

/**
 * A row as it was when its embedding was requested (Codex round 7 #22). The
 * migration upserts only while the SAME object is still in the map with the
 * same version and content: a row deleted (or rewritten) while its embedding
 * was in flight is skipped, never resurrected.
 */
interface InFlightRow {
  readonly entry: UnifiedMemoryEntry;
  readonly version: unknown;
  readonly content: string;
  newEmbedding: Vector<number>;
}

/** The row's write version (analysis rows carry a string; compared as-is). */
function rowVersion(entry: UnifiedMemoryEntry): unknown {
  return (entry as { version?: unknown }).version;
}

/** True when the row is still the live one in the store. */
export function isStillLive(ctx: { entries: Map<string, UnifiedMemoryEntry> }, row: Omit<InFlightRow, "newEmbedding">): boolean {
  const live = ctx.entries.get(row.entry.id as string);
  return live === row.entry && rowVersion(live) === row.version && live.content === row.content;
}

/**
 * Embed the contents of `rows` — through the provider's array form in
 * chunks when configured, else one call per row. Rows the provider could not
 * embed are dropped and counted.
 */
async function embedRows(
  ctx: AgentDBVectorContext,
  rows: Array<Omit<InFlightRow, "newEmbedding">>,
): Promise<{ embedded: InFlightRow[]; failed: number }> {
  const embedded: InFlightRow[] = [];
  let failed = 0;
  const batchFn = ctx.config.embeddingProviderBatch;
  const single = ctx.config.embeddingProvider!;

  const embedOneByOne = async (chunk: Array<Omit<InFlightRow, "newEmbedding">>): Promise<void> => {
    for (const row of chunk) {
      try {
        const newEmbedding = await single(row.content) as Vector<number>;
        embedded.push({ ...row, newEmbedding });
      } catch (entryError) {
        failed++;
        getLoggerSafe().warn("[AgentDB] Failed to re-embed entry, skipping", {
          entryId: row.entry.id as string,
          error: String(entryError),
        });
      }
    }
  };

  for (let start = 0; start < rows.length; start += RE_EMBED_BATCH_SIZE) {
    const chunk = rows.slice(start, start + RE_EMBED_BATCH_SIZE);
    if (!batchFn) {
      await embedOneByOne(chunk);
      continue;
    }
    try {
      const vectors = await batchFn(chunk.map((row) => row.content));
      if (!Array.isArray(vectors) || vectors.length !== chunk.length) {
        throw new Error(`batch provider returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${chunk.length} texts`);
      }
      chunk.forEach((row, i) => embedded.push({ ...row, newEmbedding: vectors[i] as Vector<number> }));
    } catch (batchError) {
      getLoggerSafe().warn("[AgentDB] Batch re-embed failed, retrying rows one by one", {
        batchSize: chunk.length,
        error: String(batchError),
      });
      await embedOneByOne(chunk);
    }
  }
  return { embedded, failed };
}

/**
 * Re-embed all hash-based entries using the current embedding provider.
 *
 * Idempotent by construction: `isHashBasedEmbedding` filters every entry
 * before the provider is called, so a clean store costs one cheap pass over
 * the in-memory map and zero provider calls. The migration marker only
 * records the last completed pass — it does NOT gate the scan. It used to:
 * once the first pass wrote `re_embed_complete_v1`, every later call
 * returned {0,0,0} without looking, so a hash vector written during a
 * provider outage after that point (generateEmbedding's fallback) was
 * never repaired and no report said so (audited 2026-09-02).
 *
 * Codex round 7 #21: rows go through `embeddingProviderBatch` in chunks of
 * RE_EMBED_BATCH_SIZE when the provider accepts arrays. Round 7 #22: a row
 * is persisted and indexed only while it is still live (same object,
 * version and content) — the check runs before the SQLite write and again
 * under the HNSW write mutex, so a delete that landed while the embedding
 * was in flight is not undone.
 */
export async function reEmbedHashEntries(
  ctx: AgentDBVectorContext,
  hasMigrationMarker: (key: string) => Promise<boolean>,
  setMigrationMarker: (key: string, metadata?: Record<string, unknown>) => Promise<void>,
): Promise<ReEmbedResult> {
  const MARKER_KEY = "re_embed_complete_v1";
  const BATCH_SIZE = RE_EMBED_BATCH_SIZE;

  if (!ctx.config.embeddingProvider) {
    getLoggerSafe().warn("[AgentDB] Re-embed skipped — no embedding provider configured");
    return { migrated: 0, total: 0, skipped: 0, hashDetected: 0, unknownDetected: 0, foreignDetected: 0 };
  }

  if (!ctx.sqliteDb) {
    getLoggerSafe().warn("[AgentDB] Re-embed skipped — SQLite not available");
    return { migrated: 0, total: 0, skipped: 0, hashDetected: 0, unknownDetected: 0, foreignDetected: 0 };
  }

  // Collect all entries that have embeddings
  const allEntries = Array.from(ctx.entries.values()).filter(
    (e) => e.embedding && e.embedding.length > 0,
  );
  const total = allEntries.length;

  getLoggerSafe().info("[AgentDB] Starting hash-to-real embedding scan", {
    totalEntries: total,
    previousPassCompleted: await hasMigrationMarker(MARKER_KEY),
  });

  let migrated = 0;
  let skipped = 0;
  let hashDetected = 0;
  let unknownDetected = 0;
  let foreignDetected = 0;
  let hadPersistFailure = false;

  // Process in batches
  for (let batchStart = 0; batchStart < allEntries.length; batchStart += BATCH_SIZE) {
    const batch = allEntries.slice(batchStart, batchStart + BATCH_SIZE);
    const toEmbed: Array<Omit<InFlightRow, "newEmbedding">> = [];

    for (const entry of batch) {
      // Histogram, unknown (#18) and foreign-provider (#17) vectors all need
      // the current provider's embedding before they can enter its index.
      const reason = needsReEmbedding(ctx.config, entry);
      if (reason === null) {
        skipped++;
        continue;
      }
      if (reason === "histogram") hashDetected++;
      else if (reason === "unknown") unknownDetected++;
      else foreignDetected++;
      toEmbed.push({ entry, version: rowVersion(entry), content: entry.content });
    }

    const { embedded, failed } = await embedRows(ctx, toEmbed);
    skipped += failed;

    // Round 7 #22: drop rows that were deleted or rewritten while their
    // embedding was in flight — persisting them would resurrect the row.
    const entriesToPersist: InFlightRow[] = [];
    for (const row of embedded) {
      if (isStillLive(ctx, row)) {
        entriesToPersist.push(row);
      } else {
        skipped++;
        getLoggerSafe().debug("[AgentDB] Re-embed skipped a row deleted or rewritten while in flight", {
          entryId: row.entry.id as string,
        });
      }
    }

    // Batch-persist updated entries to SQLite in a transaction
    if (entriesToPersist.length > 0 && ctx.sqliteDb) {
      try {
        const stmt = ctx.sqliteStatements.get("upsertMemory");
        if (stmt) {
          ctx.sqliteDb.transaction(() => {
            for (const { entry, newEmbedding } of entriesToPersist) {
              upsertEntryRow(
                stmt,
                {
                  ...entry,
                  embedding: newEmbedding,
                  embeddingProvenance: providerProvenance(ctx.config),
                } as UnifiedMemoryEntry,
              );
            }
          })();
        } else {
          throw new Error("upsertMemory statement unavailable");
        }
      } catch (persistError) {
        hadPersistFailure = true;
        skipped += entriesToPersist.length;
        getLoggerSafe().warn("[AgentDB] Failed to persist batch during re-embed", {
          error: String(persistError),
          batchSize: entriesToPersist.length,
        });
        continue;
      }

      for (const { entry, newEmbedding } of entriesToPersist) {
        (entry as unknown as { embedding: Vector<number>; embeddingProvenance: EmbeddingProvenance }).embedding = newEmbedding;
        (entry as unknown as { embeddingProvenance: EmbeddingProvenance }).embeddingProvenance = providerProvenance(ctx.config);
      }

      if (ctx.hnswStore) {
        const store = ctx.hnswStore;
        try {
          await ctx.writeMutex.withLock(async () => {
            // Round 7 #22: re-check under the mutex — a delete that took the
            // lock between the SQLite write and here must win.
            const live = entriesToPersist.filter((row) => isStillLive(ctx, row));
            if (live.length === 0) return;
            await store.upsert(
              live.map(({ entry, newEmbedding }) => ({
                id: entry.id as string,
                vector: newEmbedding,
                chunk: {
                  id: entry.id as string,
                  content: entry.content,
                  contentHash: "",
                  filePath: (entry.chatId as string) ?? "memory",
                  indexedAt: entry.createdAt as TimestampMs,
                  kind: "class" as const,
                  startLine: 0,
                  endLine: 0,
                  language: "typescript",
                },
                addedAt: entry.createdAt as TimestampMs,
                accessCount: entry.accessCount,
              })),
            );
          });
        } catch (indexError) {
          getLoggerSafe().warn("[AgentDB] Failed to update HNSW during re-embed", {
            error: String(indexError),
            batchSize: entriesToPersist.length,
          });
        }
      }

      migrated += entriesToPersist.length;
    }

    getLoggerSafe().info(`[AgentDB] Re-embedding: ${migrated}/${total} entries migrated`);
  }

  if (!hadPersistFailure) {
    await setMigrationMarker(MARKER_KEY, { migrated, total, skipped, hashDetected, unknownDetected, foreignDetected });
  } else {
    getLoggerSafe().warn("[AgentDB] Re-embed finished with persistence failures; migration marker not set", {
      migrated,
      total,
      skipped,
      hashDetected,
      unknownDetected,
      foreignDetected,
    });
  }

  getLoggerSafe().info("[AgentDB] Hash-to-real embedding scan complete", {
    migrated,
    total,
    skipped,
    hashDetected,
    unknownDetected,
    foreignDetected,
  });

  return { migrated, total, skipped, hashDetected, unknownDetected, foreignDetected };
}
