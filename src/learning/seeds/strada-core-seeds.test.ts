import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../storage/learning-storage.ts";
import { STRADA_SEEDS, seedStradaConventions } from "./strada-core-seeds.ts";
import { STRADA_MCP_SEEDS, seedMCPConventions } from "./strada-mcp-seeds.ts";

describe("Strada.Core Seeds", () => {
  let storage: LearningStorage;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "seeds-test-"));
    dbPath = join(tempDir, "test.db");
    storage = new LearningStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should define 5 seed instincts with correct structure", () => {
    expect(STRADA_SEEDS).toHaveLength(5);

    for (const seed of STRADA_SEEDS) {
      expect(seed.pattern).toBeTruthy();
      expect(seed.action.description).toBeTruthy();
      expect(seed.scope).toBe("global");
      expect(seed.confidence).toBe(0.65);
      expect(seed.trustLevel).toBe("warn_enabled");
      expect(seed.seed).toBe(true);
    }
  });

  it("should not create duplicate seeds on re-run", async () => {
    await seedStradaConventions(storage);
    await seedStradaConventions(storage);

    const stats = storage.getStats();
    // Exactly 5 instincts — second run is a no-op
    expect(stats.instinctCount).toBe(5);
  });

  it("should skip seeding if pattern already exists at global scope", async () => {
    // Seed once to populate
    await seedStradaConventions(storage);

    const firstPattern = STRADA_SEEDS[0].pattern;
    const before = storage.getInstinctByPattern(firstPattern, "global");
    expect(before).not.toBeNull();

    // Seed again — should not create a duplicate
    await seedStradaConventions(storage);

    const stats = storage.getStats();
    expect(stats.instinctCount).toBe(5);

    // The instinct for the first pattern is unchanged
    const after = storage.getInstinctByPattern(firstPattern, "global");
    expect(after?.id).toBe(before?.id);
  });

  it("should store each seed with type=seed and status=active", async () => {
    await seedStradaConventions(storage);

    for (const seed of STRADA_SEEDS) {
      const instinct = storage.getInstinctByPattern(seed.pattern, "global");
      expect(instinct).not.toBeNull();
      expect(instinct?.type).toBe("seed");
      expect(instinct?.status).toBe("active");
      expect(instinct?.confidence).toBe(0.65);
      expect(instinct?.trustLevel).toBe("warn_enabled");
      expect(instinct?.seed).toBe(true);
    }
  });

  // audited 2026-09-02: seeds were registered with project_path "" which the
  // default "project+universal" scope filter never matches, so the boot-time
  // baseline could not be retrieved by InstinctRetriever on any deployment.
  describe("scoped retrievability (audited 2026-09-02)", () => {
    const PROJECT = "/Users/someone/UnityProject";

    it("core seeds are returned under the default project+universal scope filter", async () => {
      await seedStradaConventions(storage);

      const retrieved = storage.getInstinctsForScope({
        projectPath: PROJECT,
        scopeFilter: "project+universal",
      });
      expect(retrieved.map(i => i.triggerPattern).sort()).toEqual(
        STRADA_SEEDS.map(s => s.pattern).sort(),
      );

      const scopes = storage.getInstinctScopes(retrieved[0].id);
      expect(scopes.some(s => s.projectPath === "*" && s.scopeType === "global")).toBe(true);
    });

    it("seed-utils seeds (MCP) are returned under the default project+universal scope filter", async () => {
      await seedMCPConventions(storage);

      const retrieved = storage.getInstinctsForScope({
        projectPath: PROJECT,
        scopeFilter: "project+universal",
      });
      expect(retrieved.map(i => i.triggerPattern).sort()).toEqual(
        STRADA_MCP_SEEDS.map(s => s.pattern).sort(),
      );
    });

    it("re-seeding repairs seeds that an older build registered under project_path ''", async () => {
      await seedStradaConventions(storage);
      // Simulate the pre-fix on-disk state: only a ('' , global) scope row.
      const db = storage.getDatabase()!;
      db.prepare("UPDATE instinct_scopes SET project_path = '' WHERE project_path = '*'").run();
      expect(storage.getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project+universal" })).toHaveLength(0);

      await seedStradaConventions(storage);

      expect(storage.getStats().instinctCount).toBe(5);
      expect(storage.getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project+universal" })).toHaveLength(5);
    });
  });
});
