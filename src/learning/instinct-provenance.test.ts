/**
 * WHAT A LEARNED INSTINCT RECORDS ABOUT THE RUN THAT LEARNED IT.
 *
 * Measured 2026-10-14 against the live proof run: 10 instincts learned in a
 * campaign, every one with `origin_session_id` null and no tag naming the
 * campaign. The column had been in the schema for months and nothing wrote it,
 * so "a lesson from sprint N changed sprint N+1" could not be answered at all:
 * the rule a later sprint was shown could not be traced to the sprint that
 * wrote it down.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.js";
import { LearningPipeline } from "./pipeline/learning-pipeline.js";
import { CAMPAIGN_TAG_PREFIX, withRunProvenance } from "./run-provenance.js";
import type { Instinct } from "./types.js";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "instinct-provenance-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  pipeline = new LearningPipeline(storage);
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const params = {
  name: "register the service",
  type: "tool_usage",
  status: "proposed",
  confidence: 0.6,
  triggerPattern: "a service is written",
  action: "register it in the module config",
  contextConditions: [],
} as unknown as Parameters<LearningPipeline["createInstinct"]>[0];

describe("an instinct learned inside a run", () => {
  it("records the run that learned it and the campaign it served", () => {
    const created = withRunProvenance({ runId: "task_abc", campaignId: "campaign_42" }, () =>
      pipeline.createInstinct(params),
    );

    const stored = storage.getInstinct(created.id) as Instinct;
    expect(stored.originSessionId).toBe("task_abc");
    expect(stored.tags).toContain(`${CAMPAIGN_TAG_PREFIX}campaign_42`);
  });

  it("records the run alone when the run serves no campaign", () => {
    const created = withRunProvenance({ runId: "task_abc" }, () => pipeline.createInstinct(params));

    const stored = storage.getInstinct(created.id) as Instinct;
    expect(stored.originSessionId).toBe("task_abc");
    expect(stored.tags.some((t) => t.startsWith(CAMPAIGN_TAG_PREFIX))).toBe(false);
  });

  it("records no origin at all outside a run, rather than inventing one", () => {
    const created = pipeline.createInstinct(params);

    const stored = storage.getInstinct(created.id) as Instinct;
    expect(stored.originSessionId ?? null).toBeNull();
    expect(stored.tags).toEqual([]);
  });
});
