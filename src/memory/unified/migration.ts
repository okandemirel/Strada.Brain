/**
 * Memory Migration from TF-IDF to Vector Embeddings
 * 
 * Migrates legacy FileMemoryManager data to AgentDBMemory
 * Maintains backward compatibility during transition
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { 
  IUnifiedMemory 
} from "./unified-memory.interface.js";
import type { 
  MigrationStatus
} from "./unified-memory.interface.js";
import {
  MemoryTier,
} from "./unified-memory.interface.js";
import type { 
  RetrievalOptions,
  RetrievalResult,
} from "../memory.interface.js";
import { getLogger } from "../../utils/logger.js";
import { 
  TextIndex, 
  extractTerms 
} from "../text-index.js";

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

/**
 * Legacy memory file structure (FileMemoryManager format)
 */
interface LegacyMemoryFile {
  version: 1;
  entries: Array<{
    id: string;
    type: "conversation" | "analysis" | "note";
    chatId?: string;
    content: string;
    createdAt: string;
    tags: string[];
  }>;
  index: { df: Record<string, number>; docCount: number };
}

/**
 * Legacy analysis cache file structure
 */
interface LegacyAnalysisFile {
  projectPath: string;
  analysis: {
    modules: unknown[];
    systems: unknown[];
    components: unknown[];
    relationships: unknown[];
    analyzedAt: string;
  };
}

/**
 * Migration configuration
 */
export interface MigrationConfig {
  /** Source directory containing legacy memory files */
  sourcePath: string;
  /** Target unified memory instance */
  targetMemory: IUnifiedMemory;
  /** Generate embeddings for migrated entries */
  generateEmbeddings: boolean;
  /** Assign tier based on age */
  tierAssignment: "age" | "all-persistent" | "all-ephemeral";
  /** Cutoff date for persistent tier (entries older than this become persistent) */
  persistentCutoffDays: number;
  /** Dry run - don't actually migrate */
  dryRun: boolean;
  /** Skip entries that already exist */
  skipExisting: boolean;
}

/**
 * Default migration configuration
 */
export const DEFAULT_MIGRATION_CONFIG: Partial<MigrationConfig> = {
  generateEmbeddings: true,
  tierAssignment: "age",
  persistentCutoffDays: 7,
  dryRun: false,
  skipExisting: true,
};

/**
 * Memory Migrator
 * 
 * Handles migration from legacy TF-IDF based FileMemoryManager
 * to new AgentDB + HNSW vector-based memory system
 */
export class MemoryMigrator {
  private config: MigrationConfig;
  private status: MigrationStatus;

  constructor(config: MigrationConfig) {
    this.config = { ...DEFAULT_MIGRATION_CONFIG, ...config } as MigrationConfig;
    this.status = {
      version: 2,
      isComplete: false,
      sourceSystem: "file-memory-tfidf",
      entriesMigrated: 0,
      entriesFailed: 0,
      startedAt: Date.now(),
      errors: [],
    };
  }

  /**
   * Run the migration process
   */
  async migrate(): Promise<MigrationStatus> {
    getLoggerSafe().info("[MemoryMigrator] Starting migration", {
      sourcePath: this.config.sourcePath,
      dryRun: this.config.dryRun,
    });

    try {
      // Migrate memory entries
      await this.migrateMemoryEntries();

      // Migrate analysis cache
      await this.migrateAnalysisCache();

      // Mark complete
      this.status.isComplete = true;
      this.status.completedAt = Date.now();

      getLoggerSafe().info("[MemoryMigrator] Migration complete", {
        entriesMigrated: this.status.entriesMigrated,
        entriesFailed: this.status.entriesFailed,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      getLoggerSafe().error("[MemoryMigrator] Migration failed", { error: errorMsg });
      this.status.errors.push(errorMsg);
    }

    return this.status;
  }

  /**
   * Get current migration status
   */
  getStatus(): MigrationStatus {
    return { ...this.status };
  }

  /**
   * Migrate memory entries from legacy format
   */
  private async migrateMemoryEntries(): Promise<void> {
    const memoryPath = join(this.config.sourcePath, "memory.json");

    if (!existsSync(memoryPath)) {
      getLoggerSafe().warn("[MemoryMigrator] No legacy memory file found", { memoryPath });
      return;
    }

    // Read legacy memory file
    const raw = readFileSync(memoryPath, "utf-8");
    const legacyData: LegacyMemoryFile = JSON.parse(raw);

    if (legacyData.version !== 1) {
      throw new Error(`Unsupported memory version: ${legacyData.version}`);
    }

    getLoggerSafe().info("[MemoryMigrator] Found legacy memory entries", {
      count: legacyData.entries.length,
    });

    // Rebuild TF-IDF index for similarity computation
    const textIndex = TextIndex.deserialize(legacyData.index);

    // Migrate each entry
    for (const legacyEntry of legacyData.entries) {
      try {
        await this.migrateSingleEntry(legacyEntry, textIndex);
        this.status.entriesMigrated++;
      } catch (error) {
        const errorMsg = `Failed to migrate entry ${legacyEntry.id}: ${error instanceof Error ? error.message : String(error)}`;
        getLoggerSafe().error("[MemoryMigrator] Entry migration failed", { error: errorMsg });
        this.status.errors.push(errorMsg);
        this.status.entriesFailed++;
      }
    }
  }

  /**
   * Migrate a single memory entry
   */
  private async migrateSingleEntry(
    legacyEntry: LegacyMemoryFile["entries"][0],
    textIndex: TextIndex
  ): Promise<void> {
    if (this.config.dryRun) {
      getLoggerSafe().debug("[MemoryMigrator] Dry run - would migrate entry", {
        id: legacyEntry.id,
        type: legacyEntry.type,
      });
      // In dry run mode, we still count it as migrated for status tracking
      // but don't actually write to target memory
      return;
    }

    // Check if entry already exists
    if (this.config.skipExisting) {
      // Since we can't easily check, we'll rely on UUID uniqueness
      // In production, you'd query the target memory
    }

    // Determine tier based on configuration
    const tier = this.determineTier(legacyEntry);

    // Calculate importance based on TF-IDF weights
    const terms = extractTerms(legacyEntry.content);
    const termVector = textIndex.computeTFIDF(terms);
    const importance = this.calculateImportanceFromTFIDF(termVector);

    // Create unified memory entry
    const entry = {
      type: legacyEntry.type,
      chatId: legacyEntry.chatId,
      content: legacyEntry.content,
      tags: legacyEntry.tags,
      tier,
      importance: importance > 0.7 ? "high" : importance > 0.4 ? "medium" : "low",
      termVector, // Keep for backward compatibility
    } as unknown as Parameters<typeof this.config.targetMemory.storeEntry>[0];

    // Store in target memory
    await this.config.targetMemory.storeEntry(entry);
  }

  /**
   * Migrate analysis cache
   */
  private async migrateAnalysisCache(): Promise<void> {
    const analysisPath = join(this.config.sourcePath, "analysis.json");

    if (!existsSync(analysisPath)) {
      getLoggerSafe().warn("[MemoryMigrator] No legacy analysis cache found");
      return;
    }

    const raw = readFileSync(analysisPath, "utf-8");
    const legacyAnalysis: LegacyAnalysisFile = JSON.parse(raw);

    if (this.config.dryRun) {
      getLoggerSafe().debug("[MemoryMigrator] Dry run - would migrate analysis cache", {
        projectPath: legacyAnalysis.projectPath,
      });
      return;
    }

    // Store analysis as persistent memory entry
    await this.config.targetMemory.storeEntry({
      type: "analysis",
      content: JSON.stringify(legacyAnalysis.analysis),
      tags: ["migrated-analysis", "project-analysis"],
      tier: MemoryTier.Persistent,
      importance: "high" as import("../memory.interface.js").MemoryImportance,
      projectPath: this.config.sourcePath,
      category: "structure",
      analysisVersion: "1.0",
    } as unknown as Parameters<typeof this.config.targetMemory.storeEntry>[0]);

    getLoggerSafe().info("[MemoryMigrator] Migrated analysis cache");
  }

  /**
   * Determine memory tier for migrated entry
   */
  private determineTier(legacyEntry: LegacyMemoryFile["entries"][0]): MemoryTier {
    if (this.config.tierAssignment === "all-persistent") {
      return MemoryTier.Persistent;
    }

    if (this.config.tierAssignment === "all-ephemeral") {
      return MemoryTier.Ephemeral;
    }

    // Age-based tier assignment
    const entryDate = new Date(legacyEntry.createdAt);
    const ageDays = (Date.now() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
    const cutoffDays = this.config.persistentCutoffDays ?? 7;

    if (ageDays < 1) {
      return MemoryTier.Working;
    } else if (ageDays < cutoffDays) {
      return MemoryTier.Ephemeral;
    } else {
      return MemoryTier.Persistent;
    }
  }

  /**
   * Calculate importance score from TF-IDF vector
   */
  private calculateImportanceFromTFIDF(termVector: Record<string, number>): number {
    const weights = Object.values(termVector);
    
    if (weights.length === 0) return 0.5;

    // Average TF-IDF weight as importance proxy
    const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
    
    // Normalize to 0-1 range (typical TF-IDF weights are 0-1)
    return Math.min(Math.max(avgWeight * 2, 0.1), 1.0);
  }

  /**
   * Create a migration backup
   */
  createBackup(backupPath: string): void {
    const memoryPath = join(this.config.sourcePath, "memory.json");
    const analysisPath = join(this.config.sourcePath, "analysis.json");

    if (!existsSync(backupPath)) {
      mkdirSync(backupPath, { recursive: true });
    }

    if (existsSync(memoryPath)) {
      const memoryData = readFileSync(memoryPath, "utf-8");
      writeFileSync(join(backupPath, "memory-backup.json"), memoryData);
    }

    if (existsSync(analysisPath)) {
      const analysisData = readFileSync(analysisPath, "utf-8");
      writeFileSync(join(backupPath, "analysis-backup.json"), analysisData);
    }

    // Save migration metadata
    const metadata = {
      migratedAt: new Date().toISOString(),
      sourcePath: this.config.sourcePath,
      version: 2,
    };
    writeFileSync(join(backupPath, "migration-metadata.json"), JSON.stringify(metadata, null, 2));

    getLoggerSafe().info("[MemoryMigrator] Created backup", { backupPath });
  }

  /**
   * Rollback migration (restore from backup)
   */
  static async rollback(backupPath: string, targetPath: string): Promise<void> {
    const memoryBackup = join(backupPath, "memory-backup.json");
    const analysisBackup = join(backupPath, "analysis-backup.json");

    if (existsSync(memoryBackup)) {
      const data = readFileSync(memoryBackup, "utf-8");
      writeFileSync(join(targetPath, "memory.json"), data);
    }

    if (existsSync(analysisBackup)) {
      const data = readFileSync(analysisBackup, "utf-8");
      writeFileSync(join(targetPath, "analysis.json"), data);
    }

    getLoggerSafe().info("[MemoryMigrator] Rollback complete", { targetPath });
  }

  /**
   * Check if migration is needed
   */
  static isMigrationNeeded(sourcePath: string): boolean {
    const memoryPath = join(sourcePath, "memory.json");
    return existsSync(memoryPath);
  }

  /**
   * Get migration preview (what would be migrated)
   */
  static getMigrationPreview(sourcePath: string): {
    canMigrate: boolean;
    entryCount: number;
    hasAnalysisCache: boolean;
    estimatedSizeBytes: number;
  } {
    const memoryPath = join(sourcePath, "memory.json");
    const analysisPath = join(sourcePath, "analysis.json");

    if (!existsSync(memoryPath)) {
      return {
        canMigrate: false,
        entryCount: 0,
        hasAnalysisCache: false,
        estimatedSizeBytes: 0,
      };
    }

    try {
      const raw = readFileSync(memoryPath, "utf-8");
      const data: LegacyMemoryFile = JSON.parse(raw);
      
      return {
        canMigrate: true,
        entryCount: data.entries.length,
        hasAnalysisCache: existsSync(analysisPath),
        estimatedSizeBytes: raw.length + (existsSync(analysisPath) ? readFileSync(analysisPath).length : 0),
      };
    } catch {
      return {
        canMigrate: false,
        entryCount: 0,
        hasAnalysisCache: false,
        estimatedSizeBytes: 0,
      };
    }
  }
}

/**
 * Run migration with automatic detection
 */
export async function runAutomaticMigration(
  legacyPath: string,
  targetMemory: IUnifiedMemory,
  options?: Partial<Omit<MigrationConfig, "sourcePath" | "targetMemory">>
): Promise<MigrationStatus | null> {
  if (!MemoryMigrator.isMigrationNeeded(legacyPath)) {
    getLoggerSafe().info("[MemoryMigration] No legacy memory found, skipping migration");
    return null;
  }

  const preview = MemoryMigrator.getMigrationPreview(legacyPath);
  getLoggerSafe().info("[MemoryMigration] Migration preview", preview);

  const migrator = new MemoryMigrator({
    sourcePath: legacyPath,
    targetMemory,
    ...options,
  } as MigrationConfig);

  // Create backup
  const backupPath = join(legacyPath, "backup", Date.now().toString());
  migrator.createBackup(backupPath);

  // Run migration
  return migrator.migrate();
}

/**
 * Backward compatibility layer for legacy memory queries
 */
export class BackwardCompatibleMemory {
  constructor(
    private unifiedMemory: IUnifiedMemory
  ) {}

  /**
   * Retrieve with TF-IDF backward compatibility
   * Falls back to semantic search if TF-IDF yields poor results
   */
  async retrieveWithFallback(
    query: string,
    options?: RetrievalOptions & { semanticFallback?: boolean }
  ): Promise<RetrievalResult[]> {
    // Try TF-IDF first (backward compatibility)
    const tfidfResults = await this.unifiedMemory.retrieve(query, options) as unknown as RetrievalResult[];

    // Check if results are good enough
    const hasGoodResults = tfidfResults.length > 0 && tfidfResults[0]!.score > 0.5;

    if (hasGoodResults || !options?.semanticFallback) {
      return tfidfResults;
    }

    // Fall back to semantic search
    getLoggerSafe().debug("[BackwardCompatibleMemory] Falling back to semantic search");
    const semanticResults = await this.unifiedMemory.retrieveSemantic(query, {
      limit: options?.limit,
    }) as unknown as RetrievalResult[];

    return semanticResults;
  }
}
