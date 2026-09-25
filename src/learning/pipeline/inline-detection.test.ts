/**
 * LRN-19 (b): inline pattern detection.
 *  - its window is per session, so a "repeated tool sequence" or "recurring
 *    error" cannot be stitched together from unrelated chats;
 *  - the instinct it creates is awaited inside the event, so two queued events
 *    cannot both pass the duplicate check and create the same rule twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPipeline } from "./learning-pipeline.ts";
import { LearningQueue } from "./learning-queue.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { PatternMatcher } from "../matching/pattern-matcher.ts";
import type { ToolResultEvent } from "../../core/event-bus.ts";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inline-detection-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  pipeline = new LearningPipeline(storage, { enabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  pipeline.stop();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const SEQUENCE = ["file_read", "file_edit", "dotnet_build"];

function ok(sessionId: string, toolName: string): ToolResultEvent {
  return { sessionId, toolName, input: {}, output: "ok", success: true, timestamp: Date.now() };
}

function failed(sessionId: string): ToolResultEvent {
  return {
    sessionId,
    toolName: "dotnet_build",
    input: {},
    output: "Build failed",
    success: false,
    errorDetails: { category: "missing_type", message: "CS0246: The type 'Enemy' could not be found", code: "CS0246" },
    timestamp: Date.now(),
  };
}

function instinctsOfType(type: string) {
  return storage.getInstincts().filter((i) => i.type === type);
}

describe("inline detection windows are per session (LRN-19)", () => {
  it("a tool sequence repeated inside one session is learned (control)", async () => {
    for (let rep = 0; rep < 3; rep++) {
      for (const tool of SEQUENCE) await pipeline.handleToolResult(ok("chat-1", tool));
    }
    expect(instinctsOfType("workflow_pattern")).toHaveLength(1);
  });

  it("a sequence that only exists across unrelated chats is not a workflow", async () => {
    // Globally the stream reads read->edit->build x3, but each chat saw one tool.
    for (let rep = 0; rep < 3; rep++) {
      for (const [i, tool] of SEQUENCE.entries()) await pipeline.handleToolResult(ok(`chat-${i}`, tool));
    }
    expect(instinctsOfType("workflow_pattern")).toHaveLength(0);
  });

  it("the same error once in each of five chats is not a recurring error", async () => {
    for (let i = 0; i < 5; i++) await pipeline.handleToolResult(failed(`chat-${i}`));
    expect(instinctsOfType("error_pattern")).toHaveLength(0);
  });
});

describe("inline instinct creation is serialized with the event queue (LRN-19)", () => {
  /**
   * A lookup that is slow the way an embedder call is: it reads the store when
   * called and answers later. Each one waits for a peer lookup (or 250 ms), so
   * an overlapping second creation is observed rather than timing-dependent.
   */
  function slowLookups(): { lookups: Array<Promise<unknown>>; maxConcurrent: () => number } {
    const matcher = (pipeline as unknown as { patternMatcher: PatternMatcher }).patternMatcher;
    const original = matcher.findSimilarInstincts.bind(matcher);
    const waiters: Array<() => void> = [];
    const lookups: Array<Promise<unknown>> = [];
    let concurrent = 0;
    let max = 0;
    vi.spyOn(matcher, "findSimilarInstincts").mockImplementation((trigger, options) => {
      const lookup = (async () => {
        concurrent++;
        max = Math.max(max, concurrent);
        for (const wake of waiters.splice(0)) wake();
        const snapshot = original(trigger, options);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        concurrent--;
        return snapshot;
      })();
      lookups.push(lookup);
      return lookup;
    });
    return { lookups, maxConcurrent: () => max };
  }

  async function runQueued(events: ToolResultEvent[], lookups: Array<Promise<unknown>>): Promise<void> {
    const queue = new LearningQueue();
    for (const event of events) queue.enqueue(() => pipeline.handleToolResult(event));
    await new Promise<void>((resolve) => queue.enqueue(async () => resolve()));
    await Promise.allSettled(lookups);
    await new Promise((resolve) => setImmediate(resolve));
    await queue.shutdown({ deadlineMs: 1000 });
  }

  it("two queued events that detect the same workflow create it once", async () => {
    const { lookups, maxConcurrent } = slowLookups();
    // From the 9th call on, every event sees read->read->read 3+ times.
    await runQueued(Array.from({ length: 10 }, () => ok("chat-1", "file_read")), lookups);

    expect(lookups).toHaveLength(2);
    expect(maxConcurrent()).toBe(1);
    expect(instinctsOfType("workflow_pattern")).toHaveLength(1);
  });

  it("two queued events that detect the same recurring error create it once", async () => {
    const { lookups, maxConcurrent } = slowLookups();
    // From the 5th failure on (minObservationsBeforeLearning), every event qualifies.
    await runQueued(Array.from({ length: 6 }, () => failed("chat-1")), lookups);

    expect(lookups).toHaveLength(2);
    expect(maxConcurrent()).toBe(1);
    expect(instinctsOfType("error_pattern")).toHaveLength(1);
  });
});
