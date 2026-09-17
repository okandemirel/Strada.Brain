/**
 * Bootstrap — Memory initialization helpers
 *
 * Extracted from bootstrap.ts to reduce file size.
 * Contains memory system initialization, schema repair, and migration logic.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config/config.js";
import { type DurationMs } from "../types/index.js";
import { FileMemoryManager } from "../memory/file-memory-manager.js";
import { AgentDBMemory } from "../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../memory/unified/agentdb-adapter.js";
import { runAutomaticMigration } from "../memory/unified/migration.js";
import type { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type * as winston from "winston";

/**
 * Stable identity of an embedding provider for vector provenance (Codex round 6
 * #17): name (the built-in providers fold the model id into it, e.g.
 * "openai:text-embedding-3-small"), a public `model` field when the name does
 * not already carry it, and the dimensions. Two providers that would produce
 * incomparable vectors never share an id; the same model always gets the same
 * id, so a restart does not re-embed the store.
 */
export function embeddingProviderIdentity(
  provider: Pick<CachedEmbeddingProvider, "name" | "dimensions"> & { model?: unknown },
): string {
  const name = typeof provider.name === "string" && provider.name.length > 0 ? provider.name : "provider";
  const model = typeof provider.model === "string" && provider.model.length > 0 ? provider.model : undefined;
  const parts = [name];
  if (model !== undefined && !name.includes(model)) parts.push(model);
  parts.push(`${provider.dimensions}d`);
  return parts.join(":");
}

/**
 * Initialize memory backend with self-healing.
 *
 * Flow:
 *   1. If memory disabled -> undefined
 *   2. If backend == "file" -> FileMemoryManager directly
 *   3. Otherwise (agentdb, default):
 *      try AgentDB -> on fail: repair schema -> retry -> on fail: fallback to FileMemoryManager
 *
 * Exported for testing.
 */
export async function initializeMemory(
  config: Config,
  logger: winston.Logger,
  embeddingProvider?: CachedEmbeddingProvider,
): Promise<IMemoryManager | undefined> {
  if (!config.memory.enabled) {
    return undefined;
  }

  // Explicit file backend — skip AgentDB entirely
  if (config.memory.backend === "file") {
    return initializeFileMemory(config, logger);
  }

  // AgentDB backend (default)
  const agentdbPath = join(config.memory.dbPath, "agentdb");
  const agentdbConfig = {
    dbPath: agentdbPath,
    dimensions: embeddingProvider?.dimensions ?? config.memory.unified.dimensions,
    maxEntriesPerTier: {
      working: config.memory.unified.tierLimits.working,
      ephemeral: config.memory.unified.tierLimits.ephemeral,
      persistent: config.memory.unified.tierLimits.persistent,
    },
    enableAutoTiering: config.memory.unified.autoTiering,
    ephemeralTtlMs: (config.memory.unified.ephemeralTtlHours * 3600000) as DurationMs,
    embeddingProvider: embeddingProvider
      ? async (text: string) => {
          const batch = await embeddingProvider.embed([text]);
          return batch.embeddings[0]!;
        }
      : undefined,
    // Codex round 6 #17: every model's vectors used to share provenance
    // "provider"; a model swap could then search one model's index with
    // another's query. The provenance gate compares this id.
    embeddingProviderId: embeddingProvider ? embeddingProviderIdentity(embeddingProvider) : undefined,
  };

  // Post-init steps shared between first attempt and repair path
  async function finalizeAgentDB(agentdb: AgentDBMemory): Promise<AgentDBAdapter> {
    if (!embeddingProvider) {
      logger.warn(
        "AgentDB running with hash-based fallback embeddings - semantic search quality is degraded. Configure an embedding provider for better results.",
      );
    }

    await triggerLegacyMigration(config, agentdb, logger);

    if (config.memory.unified.autoTiering) {
      agentdb.startAutoTiering(
        config.memory.unified.autoTieringIntervalMs,
        config.memory.unified.promotionThreshold,
        config.memory.unified.demotionTimeoutDays,
      );
      logger.info("Auto-tiering enabled", {
        intervalMs: config.memory.unified.autoTieringIntervalMs,
        promotionThreshold: config.memory.unified.promotionThreshold,
        demotionTimeoutDays: config.memory.unified.demotionTimeoutDays,
      });
    }

    agentdb.setDecayConfig(config.memory.decay);

    // Fire-and-forget: migrate hash embeddings to real embeddings. The scan
    // runs on every boot (the marker no longer gates it — audited 2026-09-02),
    // so the log names what was scanned and what was found rather than
    // staying silent, which read like "nothing to repair". Since Codex round 6
    // #17/#18 the same pass re-embeds vectors of unknown origin and vectors
    // of a different provider id (model swap) — the index never searches
    // across them, so this is the only path that brings them back.
    const agentdbAny = agentdb as unknown as Record<string, unknown>;
    if (embeddingProvider && typeof agentdbAny.reEmbedHashEntries === "function") {
      (
        agentdbAny.reEmbedHashEntries as () => Promise<{
          migrated: number;
          total: number;
          skipped: number;
          hashDetected: number;
          unknownDetected?: number;
          foreignDetected?: number;
        }>
      )()
        .then((result) => {
          const unknown = result.unknownDetected ?? 0;
          const foreign = result.foreignDetected ?? 0;
          const stale = result.hashDetected + unknown + foreign;
          if (stale > 0) {
            const failed = stale - result.migrated;
            logger.info(
              `[Bootstrap] Re-embedded ${result.migrated}/${stale} stale entries (${result.hashDetected} hash, ${unknown} unknown provenance, ${foreign} other provider) out of ${result.total} scanned${failed > 0 ? ` (${failed} still stale: provider or persist failure)` : ""}`,
            );
          } else {
            logger.info(
              `[Bootstrap] Embedding scan: ${result.total} entries scanned, 0 stale embeddings found`,
            );
          }
        })
        .catch((err) => {
          logger.warn(
            `[Bootstrap] Re-embed migration failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    return new AgentDBAdapter(agentdb);
  }

  // First attempt
  try {
    const agentdb = new AgentDBMemory(agentdbConfig);
    const initResult = await agentdb.initialize();
    if (initResult.kind === "ok") {
      logger.info("AgentDB memory initialized", { dbPath: agentdbPath });
      return await finalizeAgentDB(agentdb);
    }
    // Init returned err — throw to enter recovery
    throw initResult.error;
  } catch (firstError) {
    logger.warn("AgentDB initialization failed, attempting schema repair", {
      error: firstError instanceof Error ? firstError.message : String(firstError),
    });

    // Attempt schema repair
    const repairOk = await attemptSchemaRepair(agentdbPath, logger);

    // Retry AgentDB after repair
    try {
      const agentdb2 = new AgentDBMemory(agentdbConfig);
      const retryResult = await agentdb2.initialize();
      if (retryResult.kind === "ok") {
        logger.info("AgentDB recovered after schema repair", { dbPath: agentdbPath });
        return await finalizeAgentDB(agentdb2);
      }
      throw retryResult.error;
    } catch (retryError) {
      logger.warn("AgentDB retry failed after repair, falling back to FileMemoryManager", {
        repairAttempted: repairOk,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
      return initializeFileMemory(config, logger);
    }
  }
}

export async function attemptSchemaRepair(dbPath: string, logger: winston.Logger): Promise<boolean> {
  try {
    const sqlitePath = join(dbPath, "memory.db");
    if (!existsSync(sqlitePath)) return true; // Fresh DB, no repair needed
    const db = new Database(sqlitePath);
    db.pragma("journal_mode = WAL");
    try {
      db.prepare("SELECT COUNT(*) FROM memories").get();
    } catch {
      logger.info("AgentDB schema repair: memories table will be recreated on next init");
    }
    db.close();
    return true;
  } catch (e) {
    logger.error("AgentDB schema repair failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Trigger legacy FileMemoryManager -> AgentDB migration if needed.
 * Non-blocking: migration failure must never prevent agent startup.
 */
export async function triggerLegacyMigration(
  config: Config,
  agentdb: AgentDBMemory,
  logger: winston.Logger,
): Promise<void> {
  try {
    const migrationStatus = await runAutomaticMigration(
      config.memory.dbPath, // sourcePath where memory.json lives
      agentdb, // IUnifiedMemory target
    );
    if (migrationStatus) {
      logger.info("Legacy memory migration completed", {
        migrated: migrationStatus.entriesMigrated,
        failed: migrationStatus.entriesFailed,
        errors: migrationStatus.errors.length,
      });
    }
  } catch (migrationError) {
    // Migration failure must not block agent startup
    logger.warn("Legacy memory migration failed, continuing with empty AgentDB", {
      error: migrationError instanceof Error ? migrationError.message : String(migrationError),
    });
  }
}

export async function initializeFileMemory(
  config: Config,
  logger: winston.Logger,
): Promise<IMemoryManager | undefined> {
  try {
    const mm = new FileMemoryManager(config.memory.dbPath);
    await mm.initialize();
    logger.info("FileMemoryManager initialized", { dbPath: config.memory.dbPath });
    return mm;
  } catch (error) {
    logger.warn("FileMemoryManager initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
