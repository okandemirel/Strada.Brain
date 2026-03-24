import { describe, expect, it } from "vitest";
import { AgentPhase } from "../agent-state.js";
import {
  buildBehavioralSnapshot,
  buildDirectiveGate,
  buildProgressAssessmentRequest,
  buildStuckCheckpointMessage,
  parseProgressAssessment,
  PROGRESS_ASSESSMENT_SYSTEM_PROMPT,
} from "./progress-assessment.js";
import type { BehavioralSnapshot, BuildBehavioralSnapshotParams, ProgressAssessment } from "./progress-assessment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "test task",
    iteration: 1,
    plan: null,
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<BehavioralSnapshot> = {}): BehavioralSnapshot {
  return {
    prompt: "fix the bug",
    currentPhase: AgentPhase.EXECUTING,
    totalStepCount: 5,
    mutationStepCount: 2,
    inspectionStepCount: 2,
    verificationStepCount: 1,
    consecutiveTextOnlyGates: 0,
    reflectionCount: 0,
    failedApproachCount: 0,
    consecutiveErrors: 0,
    touchedFileCount: 3,
    hasActivePlan: true,
    lastToolName: "file_write",
    timeSinceLastMutationMs: 1000,
    draftExcerpt: "some draft text",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildBehavioralSnapshot
// ---------------------------------------------------------------------------

describe("buildBehavioralSnapshot", () => {
  it("classifies steps into mutation, inspection, and verification", () => {
    const now = Date.now();
    const params: BuildBehavioralSnapshotParams = {
      prompt: "create a new module",
      state: makeState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "", timestamp: now - 5000 },
          { toolName: "grep_search", success: true, summary: "", timestamp: now - 4000 },
          { toolName: "file_write", success: true, summary: "", timestamp: now - 3000 },
          { toolName: "file_edit", success: true, summary: "", timestamp: now - 2000 },
          { toolName: "dotnet_build", success: true, summary: "", timestamp: now - 1000 },
        ],
      }),
      touchedFileCount: 2,
      consecutiveTextOnlyGates: 1,
      taskStartedAtMs: now - 10000,
      draftExcerpt: "editing files",
    };

    const snap = buildBehavioralSnapshot(params);
    expect(snap.totalStepCount).toBe(5);
    expect(snap.mutationStepCount).toBe(2);
    expect(snap.inspectionStepCount).toBe(2);
    expect(snap.verificationStepCount).toBe(1);
    expect(snap.consecutiveTextOnlyGates).toBe(1);
    expect(snap.touchedFileCount).toBe(2);
    expect(snap.lastToolName).toBe("dotnet_build");
  });

  it("handles empty step results", () => {
    const now = Date.now();
    const params: BuildBehavioralSnapshotParams = {
      prompt: "do something",
      state: makeState(),
      touchedFileCount: 0,
      consecutiveTextOnlyGates: 3,
      taskStartedAtMs: now - 5000,
      draftExcerpt: "",
    };

    const snap = buildBehavioralSnapshot(params);
    expect(snap.totalStepCount).toBe(0);
    expect(snap.mutationStepCount).toBe(0);
    expect(snap.inspectionStepCount).toBe(0);
    expect(snap.verificationStepCount).toBe(0);
    expect(snap.lastToolName).toBeNull();
    expect(snap.timeSinceLastMutationMs).toBeGreaterThanOrEqual(5000);
  });

  it("reflects plan presence", () => {
    const now = Date.now();
    const withPlan = buildBehavioralSnapshot({
      prompt: "task",
      state: makeState({ plan: "step 1, step 2" }),
      touchedFileCount: 0,
      consecutiveTextOnlyGates: 0,
      taskStartedAtMs: now,
      draftExcerpt: "",
    });
    expect(withPlan.hasActivePlan).toBe(true);

    const noPlan = buildBehavioralSnapshot({
      prompt: "task",
      state: makeState({ plan: null }),
      touchedFileCount: 0,
      consecutiveTextOnlyGates: 0,
      taskStartedAtMs: now,
      draftExcerpt: "",
    });
    expect(noPlan.hasActivePlan).toBe(false);
  });

  it("truncates prompt and draftExcerpt to 200 chars", () => {
    const longText = "a".repeat(500);
    const now = Date.now();
    const snap = buildBehavioralSnapshot({
      prompt: longText,
      state: makeState(),
      touchedFileCount: 0,
      consecutiveTextOnlyGates: 0,
      taskStartedAtMs: now,
      draftExcerpt: longText,
    });
    expect(snap.prompt.length).toBe(200);
    expect(snap.draftExcerpt.length).toBe(200);
  });

  it("computes timeSinceLastMutationMs from last mutation step", () => {
    const now = Date.now();
    const mutationTs = now - 2000;
    const snap = buildBehavioralSnapshot({
      prompt: "task",
      state: makeState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "", timestamp: now - 5000 },
          { toolName: "file_write", success: true, summary: "", timestamp: mutationTs },
          { toolName: "grep_search", success: true, summary: "", timestamp: now - 1000 },
        ],
      }),
      touchedFileCount: 1,
      consecutiveTextOnlyGates: 0,
      taskStartedAtMs: now - 10000,
      draftExcerpt: "",
    });
    // Should be approximately now - mutationTs (2000ms), allow some tolerance
    expect(snap.timeSinceLastMutationMs).toBeGreaterThanOrEqual(1900);
    expect(snap.timeSinceLastMutationMs).toBeLessThan(3000);
  });

  it("includes reflectionCount and failedApproachCount from state", () => {
    const now = Date.now();
    const snap = buildBehavioralSnapshot({
      prompt: "task",
      state: makeState({
        reflectionCount: 3,
        failedApproaches: ["approach1", "approach2"],
        consecutiveErrors: 5,
      }),
      touchedFileCount: 0,
      consecutiveTextOnlyGates: 0,
      taskStartedAtMs: now,
      draftExcerpt: "",
    });
    expect(snap.reflectionCount).toBe(3);
    expect(snap.failedApproachCount).toBe(2);
    expect(snap.consecutiveErrors).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseProgressAssessment
// ---------------------------------------------------------------------------

describe("parseProgressAssessment", () => {
  it("parses valid JSON with verdict and confidence", () => {
    const result = parseProgressAssessment('{"verdict":"progressing","confidence":"high"}');
    expect(result).toEqual({ verdict: "progressing", confidence: "high", directive: undefined });
  });

  it("parses stuck verdict with directive", () => {
    const result = parseProgressAssessment(
      '{"verdict":"stuck","confidence":"medium","directive":"Use file_read to inspect the config"}',
    );
    expect(result).toEqual({
      verdict: "stuck",
      confidence: "medium",
      directive: "Use file_read to inspect the config",
    });
  });

  it("parses JSON wrapped in markdown code block", () => {
    const result = parseProgressAssessment(
      '```json\n{"verdict":"stuck","confidence":"low","directive":"read the file"}\n```',
    );
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("stuck");
    expect(result!.confidence).toBe("low");
  });

  it("extracts JSON embedded in surrounding text", () => {
    const result = parseProgressAssessment(
      'Here is my assessment: {"verdict":"progressing","confidence":"high"} as requested.',
    );
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("progressing");
  });

  it("returns null for invalid JSON", () => {
    expect(parseProgressAssessment("not json at all")).toBeNull();
  });

  it("returns null for missing verdict", () => {
    expect(parseProgressAssessment('{"confidence":"high"}')).toBeNull();
  });

  it("returns null for invalid verdict value", () => {
    expect(parseProgressAssessment('{"verdict":"maybe","confidence":"high"}')).toBeNull();
  });

  it("returns null for invalid confidence value", () => {
    expect(parseProgressAssessment('{"verdict":"stuck","confidence":"extreme"}')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseProgressAssessment("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildProgressAssessmentRequest
// ---------------------------------------------------------------------------

describe("buildProgressAssessmentRequest", () => {
  it("formats all snapshot fields into the request", () => {
    const snap = makeSnapshot();
    const request = buildProgressAssessmentRequest(snap);
    expect(request).toContain("User goal: fix the bug");
    expect(request).toContain("Phase: executing");
    expect(request).toContain("Steps: 5 total (2 mutations, 2 inspections, 1 verifications)");
    expect(request).toContain("Consecutive text-only gates: 0");
    expect(request).toContain("Reflections: 0, Failed approaches: 0");
    expect(request).toContain("Files touched: 3");
    expect(request).toContain("Has plan: true");
    expect(request).toContain("Last tool: file_write");
    expect(request).toContain("Time since last mutation: 1000ms");
    expect(request).toContain("Current draft excerpt: some draft text");
    expect(request).toContain("Is this agent making meaningful progress or stuck?");
  });

  it("shows 'none' when lastToolName is null", () => {
    const snap = makeSnapshot({ lastToolName: null });
    const request = buildProgressAssessmentRequest(snap);
    expect(request).toContain("Last tool: none");
  });
});

// ---------------------------------------------------------------------------
// buildDirectiveGate
// ---------------------------------------------------------------------------

describe("buildDirectiveGate", () => {
  it("includes directive when provided", () => {
    const assessment: ProgressAssessment = {
      verdict: "stuck",
      confidence: "high",
      directive: "Use file_read on src/config.ts",
    };
    const gate = buildDirectiveGate(assessment);
    expect(gate).toContain("[PROGRESS ASSESSMENT]");
    expect(gate).toContain("STOP generating text-only responses.");
    expect(gate).toContain("Required next action: Use file_read on src/config.ts");
    expect(gate).toContain("Do not produce another text-only analysis response.");
  });

  it("uses fallback message when no directive", () => {
    const assessment: ProgressAssessment = {
      verdict: "stuck",
      confidence: "medium",
    };
    const gate = buildDirectiveGate(assessment);
    expect(gate).toContain("Use your available tools");
    expect(gate).not.toContain("Required next action:");
  });

  it("trims whitespace-only directive and uses fallback", () => {
    const assessment: ProgressAssessment = {
      verdict: "stuck",
      confidence: "low",
      directive: "   ",
    };
    const gate = buildDirectiveGate(assessment);
    expect(gate).toContain("Use your available tools");
  });
});

// ---------------------------------------------------------------------------
// buildStuckCheckpointMessage
// ---------------------------------------------------------------------------

describe("buildStuckCheckpointMessage", () => {
  it("includes touched files when present", () => {
    const assessment: ProgressAssessment = {
      verdict: "stuck",
      confidence: "high",
      directive: "inspect the config file",
    };
    const msg = buildStuckCheckpointMessage("fix bug in config", assessment, [
      "src/config.ts",
      "src/index.ts",
    ]);
    expect(msg).toContain("Blocked checkpoint:");
    expect(msg).toContain("Task: fix bug in config");
    expect(msg).toContain("Assessment: stuck (high confidence)");
    expect(msg).toContain("Suggested action: inspect the config file");
    expect(msg).toContain("Files touched: src/config.ts, src/index.ts");
    expect(msg).toContain("Reason:");
  });

  it("shows (none) when no files touched", () => {
    const assessment: ProgressAssessment = {
      verdict: "stuck",
      confidence: "medium",
    };
    const msg = buildStuckCheckpointMessage("some task", assessment, []);
    expect(msg).toContain("Files touched: (none)");
  });

  it("limits files to first 5", () => {
    const assessment: ProgressAssessment = {
      verdict: "stuck",
      confidence: "low",
    };
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const msg = buildStuckCheckpointMessage("task", assessment, files);
    expect(msg).toContain("a.ts, b.ts, c.ts, d.ts, e.ts");
    expect(msg).not.toContain("f.ts");
  });

  it("truncates long prompts to 200 chars", () => {
    const assessment: ProgressAssessment = { verdict: "stuck", confidence: "high" };
    const longPrompt = "x".repeat(500);
    const msg = buildStuckCheckpointMessage(longPrompt, assessment, []);
    expect(msg).toContain("Task: " + "x".repeat(200));
    expect(msg).not.toContain("x".repeat(201));
  });
});

// ---------------------------------------------------------------------------
// PROGRESS_ASSESSMENT_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("PROGRESS_ASSESSMENT_SYSTEM_PROMPT", () => {
  it("contains key terms for progress assessment", () => {
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain("progress assessor");
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain("progressing");
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain("stuck");
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain("behavioral snapshot");
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain("Return JSON only");
  });

  it("specifies valid verdict and confidence values", () => {
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain('"progressing"');
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain('"stuck"');
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain('"high"');
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain('"medium"');
    expect(PROGRESS_ASSESSMENT_SYSTEM_PROMPT).toContain('"low"');
  });
});
