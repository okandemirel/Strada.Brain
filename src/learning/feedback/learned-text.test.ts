/**
 * Learning taught from a message is stored as a bounded summary.
 *
 * Measured: a 16 KB pasted text containing "instead" was stored whole as a
 * correction and came back as a 16,179-character insight, rendered into the
 * system prompt of every run it matched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { capLearnedText, MAX_LEARNED_TEXT_CHARS } from "./learned-text.js";
import { LearningStorage } from "../storage/learning-storage.js";
import { LearningPipeline } from "../pipeline/learning-pipeline.js";

describe("capLearnedText", () => {
  it("leaves text within the cap untouched", () => {
    expect(capLearnedText("prefer UniTask over Task")).toBe("prefer UniTask over Task");
  });

  it("cuts longer text to the cap and says it was cut", () => {
    const capped = capLearnedText("x".repeat(5000));

    expect(capped.length).toBeLessThanOrEqual(MAX_LEARNED_TEXT_CHARS);
    expect(capped).toMatch(/…\[truncated\]$/u);
  });

  it("never leaves half of a surrogate pair at the cut", () => {
    const capped = capLearnedText("😀".repeat(50), 20);

    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("what the pipeline keeps of a teaching or correction", () => {
  let storage: LearningStorage;
  let pipeline: LearningPipeline;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
    pipeline = new LearningPipeline(storage, {
      enabled: true,
      detectionIntervalMs: 1000,
      evolutionIntervalMs: 5000,
      minConfidenceForCreation: 0.1,
      batchSize: 5,
    });
    pipeline.setProjectPath("/projects/pixelflow");
  });

  afterEach(() => {
    pipeline.stop();
    storage.close();
  });

  it("stores a long teaching as a capped action", async () => {
    const id = await pipeline.teachExplicit(`always ${"do the documented thing ".repeat(800)}`, "user", "alice");

    const action = storage.getInstinct(id)!.action;
    expect(action.length).toBeLessThanOrEqual(MAX_LEARNED_TEXT_CHARS);
    expect(action).toMatch(/…\[truncated\]$/u);
  });

  it("stores a long correction as a capped action and a capped feedback row", async () => {
    const pasted = `use the new loader instead ${"of the old loader, as the spec says. ".repeat(440)}`;
    expect(pasted.length).toBeGreaterThan(16_000);

    const feedback = vi.spyOn(storage, "storeFeedback");

    await pipeline.recordCorrection({
      original: "I used the old loader.",
      corrected: pasted,
      source: "natural_language",
      userId: "alice",
    });

    for (const instinct of storage.getInstincts({ type: "correction" })) {
      expect(instinct.action.length).toBeLessThanOrEqual(MAX_LEARNED_TEXT_CHARS);
    }
    expect(feedback).toHaveBeenCalledTimes(1);
    const content = feedback.mock.calls[0]![0].content ?? "";
    expect(content.length).toBeLessThan(2 * MAX_LEARNED_TEXT_CHARS + 64);
  });
});
