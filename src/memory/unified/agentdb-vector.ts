/**
 * AgentDB HNSW / Vector Helpers
 *
 * Extracted from AgentDBMemory — standalone functions for HNSW indexing,
 * embedding generation, dimension mismatch handling, and hash-to-real migration.
 */

import { join } from "node:path";
import { rmSync } from "node:fs";
import type { UnifiedMemoryConfig, UnifiedMemoryEntry } from "./unified-memory.interface.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import { createHNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
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
// Embedding generation
// ---------------------------------------------------------------------------

/** Generate an embedding using the configured provider, falling back to hash-based. */
export async function generateEmbedding(
  config: UnifiedMemoryConfig,
  text: string,
): Promise<Vector<number>> {
  if (config.embeddingProvider) {
    try {
      return await config.embeddingProvider(text) as Vector<number>;
    } catch (error) {
      getLoggerSafe().warn("[AgentDBMemory] Embedding provider failed, using hash fallback", { error: String(error) });
      // Fall through to hash-based fallback
    }
  }
  // Hash-based fallback — not semantic, used when no provider configured or provider fails
  const dimensions = config.dimensions;
  const embedding = new Array(dimensions).fill(0);

  // Simple hash-based embedding for demonstration
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    embedding[i % dimensions]! += char / 255;
  }

  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((a: number, b: number) => a + b * b, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i]! /= magnitude;
    }
  }

  return embedding as Vector<number>;
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
  // component is >= 0. If no value is negative, it's hash-based.
  return !embedding.some((v) => v < -1e-9);
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
    ctx.hnswStore = await createHNSWVectorStore(vectorStorePath, {
      dimensions: ctx.config.dimensions,
      maxElements: Object.values(ctx.config.maxEntriesPerTier).reduce((a, b) => a + b, 0),
      M: ctx.config.hnswParams.M,
      efConstruction: ctx.config.hnswParams.efConstruction,
      efSearch: ctx.config.hnswParams.efSearch,
      metric: "cosine",
      quantization: ctx.config.quantizationType,
    });

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
        // Re-embed the entry content
        const newEmbedding = await generateEmbedding(ctx.config, entry.content);
        (entry as unknown as { embedding: Vector<number> }).embedding = newEmbedding;

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

/**
 * Re-embed all hash-based entries using the current embedding provider.
 * Idempotent: checks the migration marker and returns immediately if already done.
 */
export async function reEmbedHashEntries(
  ctx: AgentDBVectorContext,
  hasMigrationMarker: (key: string) => Promise<boolean>,
  setMigrationMarker: (key: string, metadata?: Record<string, unknown>) => Promise<void>,
): Promise<{ migrated: number; total: number; skipped: number }> {
  const MARKER_KEY = "re_embed_complete_v1";
  const BATCH_SIZE = 50;

  // Idempotency check
  if (await hasMigrationMarker(MARKER_KEY)) {
    return { migrated: 0, total: 0, skipped: 0 };
  }

  if (!ctx.config.embeddingProvider) {
    getLoggerSafe().warn("[AgentDB] Re-embed skipped — no embedding provider configured");
    return { migrated: 0, total: 0, skipped: 0 };
  }

  if (!ctx.sqliteDb) {
    getLoggerSafe().warn("[AgentDB] Re-embed skipped — SQLite not available");
    return { migrated: 0, total: 0, skipped: 0 };
  }

  // Collect all entries that have embeddings
  const allEntries = Array.from(ctx.entries.values()).filter(
    (e) => e.embedding && e.embedding.length > 0,
  );
  const total = allEntries.length;

  getLoggerSafe().info("[AgentDB] Starting hash-to-real embedding migration", {
    totalEntries: total,
  });

  let migrated = 0;
  let skipped = 0;
  let hadPersistFailure = false;

  // Process in batches
  for (let batchStart = 0; batchStart < allEntries.length; batchStart += BATCH_SIZE) {
    const batch = allEntries.slice(batchStart, batchStart + BATCH_SIZE);
    const entriesToPersist: Array<{
      entry: UnifiedMemoryEntry;
      newEmbedding: Vector<number>;
    }> = [];

    for (const entry of batch) {
      const embeddingArr = entry.embedding as unknown as number[];
      if (!isHashBasedEmbedding(entry.content, embeddingArr)) {
        skipped++;
        continue;
      }

      try {
        const newEmbedding = await ctx.config.embeddingProvider!(entry.content) as Vector<number>;
        entriesToPersist.push({ entry, newEmbedding });
      } catch (entryError) {
        skipped++;
        getLoggerSafe().warn("[AgentDB] Failed to re-embed entry, skipping", {
          entryId: entry.id as string,
          error: String(entryError),
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
        (entry as unknown as { embedding: Vector<number> }).embedding = newEmbedding;
      }

      if (ctx.hnswStore) {
        const store = ctx.hnswStore;
        try {
          await ctx.writeMutex.withLock(() =>
            store.upsert(
              entriesToPersist.map(({ entry, newEmbedding }) => ({
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
            ),
          );
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
    await setMigrationMarker(MARKER_KEY, { migrated, total, skipped });
  } else {
    getLoggerSafe().warn("[AgentDB] Re-embed finished with persistence failures; migration marker not set", {
      migrated,
      total,
      skipped,
    });
  }

  getLoggerSafe().info("[AgentDB] Hash-to-real embedding migration complete", {
    migrated,
    total,
    skipped,
  });

  return { migrated, total, skipped };
}
