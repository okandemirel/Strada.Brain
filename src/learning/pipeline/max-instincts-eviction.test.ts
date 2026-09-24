/**
 * LRN-18: the creation paths' maxInstincts eviction.
 *
 * It was an async method called without await or catch, so a storage error
 * became an unhandled rejection (which the process counts towards shutting the
 * daemon down), and it could evict the instinct that had just been created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../storage/learning-storage.ts";
import { LearningPipeline } from "./learning-pipeline.ts";
import type { Instinct } from "../types.ts";
import type { TimestampMs } from "../../types/index.ts";

let dir: string;
let storage: LearningStorage;

function proposed(id: string, confidence: number): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id,
    name: id,
    type: "error_fix",
    status: "proposed",
    confidence,
    triggerPattern: `unrelated trigger number ${id}`,
    action: `unrelated action ${id}`,
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
  } as unknown as Instinct;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "max-instincts-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
});

afterEach(() => {
  vi.restoreAllMocks();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("maxInstincts eviction on creation (LRN-18)", () => {
  it("never evicts the instinct that was just created", async () => {
    const pipeline = new LearningPipeline(storage, { maxInstincts: 2, minConfidenceForCreation: 0.1 });
    storage.createInstinct(proposed("existing_a", 0.45));
    storage.createInstinct(proposed("existing_b", 0.45));

    const created = await pipeline.considerInstinctCreation({
      type: "error_fix",
      triggerPattern: "error CS0103 the name does not exist in the current context",
      action: "declare the missing variable before use",
      confidence: 0.2,
    });

    expect(created).not.toBeNull();
    expect(storage.getInstinct(created!.id)).not.toBeNull();
    expect(storage.countInstincts()).toBe(2);
  });

  it("a storage error during eviction does not escape as an unhandled rejection", async () => {
    const pipeline = new LearningPipeline(storage, { maxInstincts: 2 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      vi.spyOn(storage, "countInstincts").mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });

      const id = await pipeline.teachExplicit("always rebuild the addressables catalog after moving assets", "user", "alice");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(storage.getInstinct(id)).not.toBeNull();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
