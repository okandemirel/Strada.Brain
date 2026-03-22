import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../storage/learning-storage.ts";
import { STRADA_SEEDS, seedStradaConventions } from "./strada-core-seeds.ts";

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
});
