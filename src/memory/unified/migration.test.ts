import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryMigrator, runAutomaticMigration, BackwardCompatibleMemory } from "./migration.js";
import { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier } from "./unified-memory.interface.js";

describe("MemoryMigrator", () => {
  let tempDir: string;
  let targetMemory: AgentDBMemory;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "migration-test-"));
    targetMemory = new AgentDBMemory({
      dbPath: join(tempDir, "agentdb"),
      dimensions: 128,
      maxEntriesPerTier: {
        [MemoryTier.Working]: 10,
        [MemoryTier.Ephemeral]: 50,
        [MemoryTier.Persistent]: 100,
      },
      hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
      quantizationType: "none",
      cacheSize: 100,
      enableAutoTiering: true,
      ephemeralTtlMs: 24 * 60 * 60 * 1000,
    });
    await targetMemory.initialize();
  });

  afterEach(async () => {
    await targetMemory.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("migration detection", () => {
    it("should detect when migration is needed", () => {
      // Create legacy memory file
      const legacyData = {
        version: 1,
        entries: [
          {
            id: "test-1",
            type: "conversation",
            chatId: "chat-1",
            content: "Test conversation",
            createdAt: new Date().toISOString(),
            tags: ["test"],
          },
        ],
        index: { df: { test: 1 }, docCount: 1 },
      };
      
      writeFileSync(join(tempDir, "memory.json"), JSON.stringify(legacyData));
      
      expect(MemoryMigrator.isMigrationNeeded(tempDir)).toBe(true);
    });

    it("should detect when migration is not needed", () => {
      expect(MemoryMigrator.isMigrationNeeded(tempDir)).toBe(false);
    });

    it("should provide migration preview", () => {
      const legacyData = {
        version: 1,
        entries: [
          { id: "test-1", type: "note", content: "Note 1", createdAt: new Date().toISOString(), tags: [] },
          { id: "test-2", type: "note", content: "Note 2", createdAt: new Date().toISOString(), tags: [] },
        ],
        index: { df: {}, docCount: 2 },
      };
      
      writeFileSync(join(tempDir, "memory.json"), JSON.stringify(legacyData));
      
      const preview = MemoryMigrator.getMigrationPreview(tempDir);
      
      expect(preview.canMigrate).toBe(true);
      expect(preview.entryCount).toBe(2);
      expect(preview.estimatedSizeBytes).toBeGreaterThan(0);
    });
  });

  describe("migration process", () => {
    beforeEach(() => {
      // Create legacy memory structure
      const legacyData = {
        version: 1,
        entries: [
          {
            id: "conv-1",
            type: "conversation",
            chatId: "chat-1",
            content: "Test conversation about machine learning",
            createdAt: new Date().toISOString(),
            tags: ["ai", "ml"],
          },
          {
            id: "note-1",
            type: "note",
            content: "Important note about project architecture",
            createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days old
            tags: ["architecture"],
          },
        ],
        index: { 
          df: { test: 2, conversation: 1, machine: 1, learning: 1, important: 1, architecture: 1 },
          docCount: 2 
        },
      };
      
      writeFileSync(join(tempDir, "memory.json"), JSON.stringify(legacyData));
    });

    it("should migrate entries successfully", async () => {
      const migrator = new MemoryMigrator({
        sourcePath: tempDir,
        targetMemory,
        generateEmbeddings: true,
        tierAssignment: "age",
        persistentCutoffDays: 7,
        dryRun: false,
        skipExisting: true,
      });

      const status = await migrator.migrate();

      expect(status.isComplete).toBe(true);
      expect(status.entriesMigrated).toBe(2);
      expect(status.entriesFailed).toBe(0);
    });

    it("should respect dry run mode", async () => {
      const migrator = new MemoryMigrator({
        sourcePath: tempDir,
        targetMemory,
        generateEmbeddings: true,
        tierAssignment: "all-persistent",
        persistentCutoffDays: 7,
        dryRun: true,
        skipExisting: true,
      });

      const status = await migrator.migrate();

      expect(status.isComplete).toBe(true);
      
      // Verify no entries were actually migrated
      const persistent = await targetMemory.getByTier(MemoryTier.Persistent);
      expect(persistent).toHaveLength(0);
    });

    it("should assign tiers based on age", async () => {
      const migrator = new MemoryMigrator({
        sourcePath: tempDir,
        targetMemory,
        generateEmbeddings: true,
        tierAssignment: "age",
        persistentCutoffDays: 7,
        dryRun: false,
        skipExisting: true,
      });

      await migrator.migrate();

      // The 10-day old entry should be persistent
      const persistent = await targetMemory.getByTier(MemoryTier.Persistent);
      expect(persistent.length).toBeGreaterThan(0);
      expect(persistent[0]!.content).toContain("architecture");
    });

    it("should create backup before migration", async () => {
      const migrator = new MemoryMigrator({
        sourcePath: tempDir,
        targetMemory,
        generateEmbeddings: true,
        tierAssignment: "age",
        persistentCutoffDays: 7,
        dryRun: false,
        skipExisting: true,
      });

      const backupPath = join(tempDir, "backup");
      migrator.createBackup(backupPath);

      expect(require("node:fs").existsSync(join(backupPath, "memory-backup.json"))).toBe(true);
    });
  });

  describe("automatic migration", () => {
    it("should skip if no legacy memory exists", async () => {
      const status = await runAutomaticMigration(tempDir, targetMemory);
      expect(status).toBeNull();
    });

    it("should run migration when legacy memory exists", async () => {
      // Create legacy memory
      const legacyData = {
        version: 1,
        entries: [{ id: "test-1", type: "note", content: "Test", createdAt: new Date().toISOString(), tags: [] }],
        index: { df: {}, docCount: 1 },
      };
      writeFileSync(join(tempDir, "memory.json"), JSON.stringify(legacyData));

      const status = await runAutomaticMigration(tempDir, targetMemory);

      expect(status).not.toBeNull();
      expect(status!.isComplete).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    beforeEach(async () => {
      // Seed with some entries
      await targetMemory.storeNote("Machine learning is fascinating", ["ai"]);
      await targetMemory.storeNote("The weather is nice today", ["weather"]);
    });

    it("should provide fallback search", async () => {
      const compatMemory = new BackwardCompatibleMemory(targetMemory);

      const results = await compatMemory.retrieveWithFallback("machine learning", {
        limit: 5,
        semanticFallback: true,
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });
});
