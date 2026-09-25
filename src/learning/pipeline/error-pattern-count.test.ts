/**
 * LRN-19: a failed tool event carrying error details recorded its error
 * pattern twice (once in handleToolResult, once when its observation was
 * processed), so every failure counted as two occurrences.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPipeline } from "./learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { ToolResultEvent } from "../../core/event-bus.ts";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "error-pattern-count-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  pipeline = new LearningPipeline(storage, { enabled: true });
});

afterEach(() => {
  pipeline.stop();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function failure(): ToolResultEvent {
  return {
    sessionId: "chat-1",
    toolName: "dotnet_build",
    input: { project: "Game.csproj" },
    output: "error CS0246: type 'Enemy' not found",
    success: false,
    retryCount: 0,
    errorDetails: { category: "syntax", message: "error CS0246: type 'Enemy' not found", code: "CS0246" },
    timestamp: Date.now(),
  };
}

describe("an error pattern is counted once per failure (LRN-19)", () => {
  it("one failed tool event is one occurrence", async () => {
    await pipeline.handleToolResult(failure());
    expect(storage.getErrorPatterns().map((p) => p.occurrenceCount)).toEqual([1]);

    await pipeline.handleToolResult(failure());
    expect(storage.getErrorPatterns().map((p) => p.occurrenceCount)).toEqual([2]);
  });
});
