import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LearningPipeline } from "./learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolName, TimestampMs } from "../../types/index.js";
import type { DevKnowledgeNoteWriter } from "../../vault/dev-knowledge-writer.js";

/**
 * LIVING VAULT (C) — learning↔vault bridge. Verifies the injected note-writer
 * receives human-readable notes on high-confidence instinct creation and on a
 * clean-success verdict, that low-confidence creations are NOT mirrored, that
 * the bridge is a no-op when unwired, and that per-id dedup holds.
 */
describe("LearningPipeline dev-knowledge bridge (C)", () => {
  let pipeline: LearningPipeline;
  let storage: LearningStorage;
  let tempDir: string;
  let notes: Array<{ relPath: string; content: string }>;
  let writer: DevKnowledgeNoteWriter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devknow-bridge-"));
    storage = new LearningStorage(join(tempDir, "test.db"));
    storage.initialize();
    pipeline = new LearningPipeline(storage, {
      enabled: true,
      minConfidenceForCreation: 0.5,
      batchSize: 5,
    });
    notes = [];
    writer = {
      async writeNote(relPath, content) {
        notes.push({ relPath, content });
        return true;
      },
    };
  });

  afterEach(() => {
    pipeline.stop();
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a learned-heuristic note when a high-confidence instinct is created", () => {
    pipeline.setNoteWriter(writer);
    pipeline.createInstinct({
      name: "teaching:high-conf",
      type: "user_teaching",
      status: "active",
      confidence: 0.85,
      triggerPattern: "when editing combat code",
      action: "always run dotnet_build after",
      contextConditions: [],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].relPath).toMatch(/^knowledge\/instincts\/.*\.md$/);
    expect(notes[0].content).toContain("## Learned Heuristic");
    expect(notes[0].content).toContain("always run dotnet_build after");
  });

  it("does NOT write a note for a low-confidence instinct (below active threshold)", () => {
    pipeline.setNoteWriter(writer);
    pipeline.createInstinct({
      name: "teaching:low-conf",
      type: "user_teaching",
      status: "proposed",
      confidence: 0.55, // below activeThreshold 0.7
      triggerPattern: "weak signal",
      action: "maybe do something",
      contextConditions: [],
    });
    expect(notes).toHaveLength(0);
  });

  it("dedups: creating-then-re-noting the same instinct id writes only once", () => {
    pipeline.setNoteWriter(writer);
    const instinct = pipeline.createInstinct({
      name: "teaching:dedup",
      type: "user_teaching",
      status: "active",
      confidence: 0.9,
      triggerPattern: "trigger",
      action: "action",
      contextConditions: [],
    });
    // Re-invoke the private bridge with the same id — must be deduped.
    (pipeline as unknown as { noteHighConfidenceInstinct(i: typeof instinct): void })
      .noteHighConfidenceInstinct(instinct);
    expect(notes).toHaveLength(1);
  });

  it("writes a clean-success verdict note when a clean trajectory is recorded", () => {
    pipeline.setNoteWriter(writer);
    pipeline.recordTrajectory({
      sessionId: "s1",
      taskRunId: "taskrun_clean",
      taskDescription: "Implemented the inventory grid cleanly",
      steps: [
        {
          stepNumber: 1,
          toolName: "file_edit" as ToolName,
          input: { path: "Inventory.cs" },
          result: { kind: "success", output: "ok" },
          timestamp: Date.now() as TimestampMs,
        },
      ],
      outcome: {
        success: true,
        totalSteps: 1,
        hadErrors: false, // clean success → autoGenerateVerdict fires
        errorCount: 0,
        durationMs: 500,
      },
    });
    const verdictNotes = notes.filter((n) => n.relPath.startsWith("knowledge/verdicts/"));
    expect(verdictNotes).toHaveLength(1);
    expect(verdictNotes[0].content).toContain("## Verified Clean Success");
    expect(verdictNotes[0].content).toContain("Implemented the inventory grid cleanly");
  });

  it("does NOT write a verdict note for a trajectory that had errors", () => {
    pipeline.setNoteWriter(writer);
    pipeline.recordTrajectory({
      sessionId: "s2",
      taskRunId: "taskrun_err",
      taskDescription: "messy run",
      steps: [],
      outcome: {
        success: true,
        totalSteps: 1,
        hadErrors: true, // not clean → no autoGenerateVerdict → no note
        errorCount: 1,
        durationMs: 500,
      },
    });
    const verdictNotes = notes.filter((n) => n.relPath.startsWith("knowledge/verdicts/"));
    expect(verdictNotes).toHaveLength(0);
  });

  it("is byte-identical no-op when no writer is wired (default)", () => {
    // No setNoteWriter call.
    expect(() =>
      pipeline.createInstinct({
        name: "teaching:nowriter",
        type: "user_teaching",
        status: "active",
        confidence: 0.95,
        triggerPattern: "t",
        action: "a",
        contextConditions: [],
      }),
    ).not.toThrow();
    expect(notes).toHaveLength(0);
  });
});
