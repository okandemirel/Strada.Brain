/**
 * Bootstrap — Memory initialization helpers
 *
 * Extracted from bootstrap.ts to reduce file size.
 * Contains memory system initialization and migration logic.
 */

import { join } from "node:path";
import type { Config } from "../config/config.js";
import { type DurationMs } from "../types/index.js";
import { FileMemoryManager } from "../memory/file-memory-manager.js";
import { AgentDBMemory } from "../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../memory/unified/agentdb-adapter.js";
import { runAutomaticMigration } from "../memory/unified/migration.js";
import type { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import { isHnswAvailable } from "../rag/hnsw/hnsw-vector-store.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type * as winston from "winston";

/**
 * What an embedding provider may expose about its identity (Codex round 7
 * #20). All optional: `describeIdentity()` is the strongest (the provider
 * names itself), then a `modelId` / `model` string. A wrapper (the embedding
 * cache) is unwrapped through its `inner` / `provider` / `wrapped` field so
 * the identity is the INNER model's, not the wrapper's name.
 */
export interface EmbeddingIdentitySource {
  readonly name?: unknown;
  readonly dimensions?: unknown;
  readonly describeIdentity?: unknown;
  readonly modelId?: unknown;
  readonly model?: unknown;
  readonly inner?: unknown;
  readonly provider?: unknown;
  readonly wrapped?: unknown;
}

/** Logged once per process: the identity fell back to name:dimensions. */
let weakIdentityLogged = false;

/** @internal test hook */
export function _resetWeakIdentityLog(): void {
  weakIdentityLogged = false;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The explicit model id a provider (or the provider it wraps) exposes, or
 * undefined when none does. Walks at most four wrapper levels.
 */
export function embeddingModelId(provider: EmbeddingIdentitySource | undefined): string | undefined {
  let current: EmbeddingIdentitySource | undefined = provider;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current.describeIdentity === "function") {
      try {
        const described = nonEmptyString((current.describeIdentity as () => unknown).call(current));
        if (described !== undefined) return described;
      } catch {
        // a throwing describer is no identity
      }
    }
    const explicit = nonEmptyString(current.modelId) ?? nonEmptyString(current.model);
    if (explicit !== undefined) return explicit;
    const next = [current.inner, current.provider, current.wrapped].find(
      (candidate) => candidate !== undefined && candidate !== null && typeof candidate === "object",
    );
    current = next as EmbeddingIdentitySource | undefined;
  }
  return undefined;
}

/**
 * Stable identity of an embedding provider for vector provenance (Codex round 6
 * #17, round 7 #20): the explicit model id when the provider — or the inner
 * provider a cache wrapper hides — exposes one (`describeIdentity()`,
 * `modelId`, `model`), joined with the name when the name does not already
 * carry it, plus the dimensions. Only when nothing else is available does it
 * fall back to name:dimensions, and it logs once that the identity is weak:
 * two custom models with the same name and dimension used to collide as
 * "custom:8d". The same model always gets the same id, so a restart does not
 * re-embed the store.
 */
export function embeddingProviderIdentity(
  provider: EmbeddingIdentitySource,
  logger?: Pick<winston.Logger, "warn">,
): string {
  const name = nonEmptyString(provider.name) ?? "provider";
  const dimensions = typeof provider.dimensions === "number" ? provider.dimensions : Number(provider.dimensions);
  const model = embeddingModelId(provider);
  const parts = [name];
  if (model !== undefined) {
    if (!name.includes(model)) parts.push(model);
  } else if (!weakIdentityLogged) {
    weakIdentityLogged = true;
    logger?.warn(
      `[Bootstrap] Embedding provider "${name}" exposes no model id; vector provenance falls back to name:dimensions, so two models with the same name and dimensions would share one index`,
    );
  }
  parts.push(`${dimensions}d`);
  return parts.join(":");
}

/**
 * Initialize memory backend.
 *
 * Flow:
 *   1. If memory disabled -> undefined
 *   2. If backend == "file" -> FileMemoryManager directly
 *   3. Otherwise (agentdb, default):
 *      try AgentDB -> on fail: fallback to FileMemoryManager
 *
 * There is no second AgentDB attempt. The old "schema repair" before it only
 * counted rows, so the retry re-ran the identical init and failed the same
 * way, leaking another SQLite handle. AgentDB heals the failure a retry could
 * have helped with itself: it discards a persisted HNSW index that no longer
 * fits and rebuilds it from SQLite, and it closes what it opened when init
 * fails (MEM-2 / X-3).
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
    // Codex round 7 #21: the re-embed migration sends rows in chunks through
    // the provider's array form instead of one serial call per row.
    embeddingProviderBatch: embeddingProvider
      ? async (texts: string[]) => (await embeddingProvider.embed(texts)).embeddings
      : undefined,
    // Codex round 6 #17: every model's vectors used to share provenance
    // "provider"; a model swap could then search one model's index with
    // another's query. The provenance gate compares this id.
    embeddingProviderId: embeddingProvider
      ? embeddingProviderIdentity(embeddingProvider as unknown as EmbeddingIdentitySource, logger)
      : undefined,
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

  let agentdb: AgentDBMemory | undefined;
  try {
    agentdb = new AgentDBMemory(agentdbConfig);
    const initResult = await agentdb.initialize();
    if (initResult.kind === "err") throw initResult.error;
    logger.info("AgentDB memory initialized", { dbPath: agentdbPath });
    if (!isHnswAvailable()) {
      // X-6: say at boot why memory search is slower than it could be.
      logger.warn(
        "hnswlib-node is not installed: AgentDB memory uses exact vector search (fine at the default tier caps, slower as the store grows). For the HNSW index install a C++ toolchain and run: npm install hnswlib-node",
      );
    }
    return await finalizeAgentDB(agentdb);
  } catch (error) {
    // A failed initialize() already released its handles; a failure after it
    // succeeded (finalize) must shut the instance down before the fallback
    // opens the same directory, or its timers and SQLite handle leak.
    await closeQuietly(agentdb);
    logger.warn("AgentDB initialization failed, falling back to FileMemoryManager", {
      error: error instanceof Error ? error.message : String(error),
    });
    return initializeFileMemory(config, logger);
  }
}

/** Best-effort shutdown of an AgentDB instance that is being abandoned. */
async function closeQuietly(agentdb: AgentDBMemory | undefined): Promise<void> {
  if (!agentdb || typeof agentdb.shutdown !== "function") return;
  try {
    await agentdb.shutdown();
  } catch {
    // Abandoning it anyway; the fallback must still run.
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
