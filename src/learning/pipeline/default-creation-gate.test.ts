/**
 * LRN-20: DEFAULT_LEARNING_CONFIG's creation gate (0.6) sat above the cap
 * every new instinct's confidence starts under (MAX_INITIAL, 0.5), so a
 * pipeline built with the defaults could never create an instinct.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPipeline } from "./learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { NormalizedScore } from "../../types/index.js";

let dir: string;
let storage: LearningStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "default-creation-gate-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the default creation gate (LRN-20)", () => {
  it("a pipeline built with the defaults creates an auto-derived instinct", async () => {
    const pipeline = new LearningPipeline(storage);
    const created = await pipeline.considerInstinctCreation({
      type: "error_fix",
      triggerPattern: "CS1061: 'Board' does not contain a definition for 'Explode'",
      action: "Add the Explode method to Board or call the existing Detonate method",
      toolName: "dotnet_build",
    });
    expect(created).not.toBeNull();
    pipeline.stop();
  });

  it("a gate no instinct could pass is refused at construction", () => {
    expect(() => new LearningPipeline(storage, { minConfidenceForCreation: 0.6 as NormalizedScore })).toThrow(RangeError);
  });
});
