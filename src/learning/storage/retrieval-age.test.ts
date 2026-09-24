/**
 * LRN-9: cross-session retrieval ages a rule by its last use or evidence.
 *
 * The age filter keyed on created_at, so 90 days after first boot every seed
 * convention and every heavily used teaching dropped out of retrieval, and an
 * aged-out rule kept refusing its own re-creation as a duplicate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./learning-storage.ts";
import { LearningPipeline } from "../pipeline/learning-pipeline.ts";
import type { Instinct } from "../types.ts";
import type { TimestampMs } from "../../types/index.ts";

const PROJECT = "/projects/age";
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let storage: LearningStorage;

function rule(id: string, fields: Partial<Instinct> & { createdDaysAgo: number; updatedDaysAgo: number }): Instinct {
  const { createdDaysAgo, updatedDaysAgo, ...rest } = fields;
  return {
    id,
    name: id,
    type: "error_fix",
    status: "active",
    confidence: 0.7,
    triggerPattern: `error CS0246 when building ${id}`,
    action: `add the using directive for ${id}`,
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: (Date.now() - createdDaysAgo * DAY) as TimestampMs,
    updatedAt: (Date.now() - updatedDaysAgo * DAY) as TimestampMs,
    sourceTrajectoryIds: [],
    tags: [],
    ...rest,
  } as unknown as Instinct;
}

function retrievable(): string[] {
  return storage
    .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project+universal", maxAgeDays: 90 })
    .map((i) => i.id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-age-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("retrieval age (LRN-9)", () => {
  it("a seed convention from 100 days ago is still retrievable", () => {
    storage.createInstinct(rule("seed_old_convention", { createdDaysAgo: 100, updatedDaysAgo: 100, seed: true, type: "seed" }));
    storage.addInstinctScopeV2("seed_old_convention", "*", "global");

    expect(retrievable()).toContain("seed_old_convention");
  });

  it("a rule created 100 days ago and used yesterday is retrievable; one untouched for 100 days is not", () => {
    storage.createInstinct(rule("rule_in_use", { createdDaysAgo: 100, updatedDaysAgo: 1 }), PROJECT);
    storage.createInstinct(rule("rule_forgotten", { createdDaysAgo: 100, updatedDaysAgo: 100 }), PROJECT);

    const ids = retrievable();
    expect(ids).toContain("rule_in_use");
    expect(ids).not.toContain("rule_forgotten");
  });

  it("learning an aged-out rule again brings it back instead of being refused as a duplicate", async () => {
    const pipeline = new LearningPipeline(storage);
    pipeline.setProjectPath(PROJECT);
    const old = rule("rule_relearned", { createdDaysAgo: 100, updatedDaysAgo: 100 });
    storage.createInstinct(old, PROJECT);
    expect(retrievable()).not.toContain("rule_relearned");

    const created = await pipeline.considerInstinctCreation({
      type: "error_fix",
      triggerPattern: old.triggerPattern,
      action: old.action,
      confidence: 0.5,
    });

    expect(created).toBeNull();
    expect(retrievable()).toContain("rule_relearned");
  });
});
