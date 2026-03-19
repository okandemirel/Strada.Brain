import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import {
  buildAutonomyDeflectionGate,
  buildCompletionReviewGate,
  collectCompletionReviewEvidence,
  hasOpenReviewFindings,
  hasOpenReviewFindingsForDraft,
  parseCompletionReviewDecision,
  shouldRunCompletionReview,
} from "./completion-review.js";

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Fix runtime issue",
    iteration: 2,
    plan: "Investigate logs and fix the failure",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

describe("completion-review", () => {
  it("keeps only chat-scoped warn/error logs after the latest clean verification", () => {
    const verificationAt = Date.parse("2026-03-18T10:00:10.000Z");
    const evidence = collectCompletionReviewEvidence({
      state: createState(),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["src/runtime/reviewer.ts"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: verificationAt,
      },
      chatId: "chat-123",
      taskStartedAtMs: Date.parse("2026-03-18T10:00:00.000Z"),
      logEntries: [
        {
          timestamp: "2026-03-18T10:00:05.000Z",
          level: "error",
          message: "too early",
          meta: { chatId: "chat-123" },
        },
        {
          timestamp: "2026-03-18T10:00:12.000Z",
          level: "info",
          message: "not severe",
          meta: { chatId: "chat-123" },
        },
        {
          timestamp: "2026-03-18T10:00:13.000Z",
          level: "warn",
          message: "keep me",
          meta: { chatId: "chat-123" },
        },
        {
          timestamp: "2026-03-18T10:00:14.000Z",
          level: "error",
          message: "other chat",
          meta: { chatId: "chat-456" },
        },
      ],
    });

    expect(evidence.recentLogIssues).toHaveLength(1);
    expect(evidence.recentLogIssues[0]?.message).toBe("keep me");
    expect(shouldRunCompletionReview(evidence)).toBe(true);
  });

  it("parses json review decisions and builds a gate prompt", () => {
    const decision = parseCompletionReviewDecision(`\`\`\`json
{"decision":"continue","summary":"Logs still show runtime problems.","findings":["Unhandled error remained in console output."],"requiredActions":["Inspect the console output and rerun verification."],"closureStatus":"partial","openInvestigations":["The runtime failure path still needs confirmation after the latest patch."],"reviews":{"security":"clean","code":"issues","simplify":"clean"},"logStatus":"issues"}
\`\`\``);
    expect(hasOpenReviewFindings(decision)).toBe(true);

    const gate = buildCompletionReviewGate(decision, {
      touchedFiles: ["src/runtime/reviewer.ts"],
      recentFailures: [],
      recentLogIssues: [
        {
          timestamp: "2026-03-18T10:00:13.000Z",
          level: "error",
          message: "Unhandled error remained in console output.",
          meta: { chatId: "chat-123" },
        },
      ],
      recentSteps: ["[OK] file_read: Read Level_031.asset"],
      totalStepCount: 1,
      inspectionStepCount: 1,
      verificationStepCount: 0,
      mutationStepCount: 0,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["src/runtime/reviewer.ts"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.parse("2026-03-18T10:00:10.000Z"),
      },
    });

    expect(gate).toContain("[COMPLETION REVIEW REQUIRED]");
    expect(gate).toContain("Unhandled error remained in console output.");
    expect(gate).toContain("Security review: clean");
    expect(gate).toContain("Closure status: partial");
    expect(gate).toContain("Open investigations:");
  });

  it("forces review when the draft makes a broad completion claim after tool activity", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-claim",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    expect(shouldRunCompletionReview(evidence, "All 100 levels analyzed successfully.")).toBe(true);
  });

  it("forces review when a read-only investigation draft claims success but leaves open runtime hypotheses", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 500 },
          { toolName: "file_read", success: true, summary: "Read GameRenderer.cs", timestamp: Date.now() - 250 },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      chatId: "chat-open-investigation",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const draft = `Build successful. Strada.Core compatible fixes are complete.

Remaining potential issues:
- ArrowInputSystem may still scan every arrow on input.
- If the freeze continues, inspect Unity Profiler CPU Usage and Call Stack.
DONE`;

    expect(shouldRunCompletionReview(evidence, draft)).toBe(true);
  });

  it("builds an autonomy gate when the draft throws the next step back to the user", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-deflection",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const gate = buildAutonomyDeflectionGate("I checked the directory. What should I do next?", evidence);
    expect(gate).toContain("[AUTONOMY REQUIRED]");
    expect(gate).toContain("Strada must continue autonomously here.");
  });

  it("builds an autonomy gate when the draft is only an internal execution plan", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() },
          { toolName: "file_read", success: true, summary: "Read Level_031.asset", timestamp: Date.now() },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-plan-drift",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const gate = buildAutonomyDeflectionGate(
      `Plan to fix the pooling compile errors

1. Run dotnet_build for the solution
2. Read the failing pooling files
3. Search the package for the missing types`,
      evidence,
    );
    expect(gate).toContain("[AUTONOMY REQUIRED]");
    expect(gate).toContain("internal execution plan or intake checklist");
  });

  it("allows an internal plan draft when the user explicitly asked for a plan", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() },
          { toolName: "file_read", success: true, summary: "Read Level_031.asset", timestamp: Date.now() },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-explicit-plan",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const draft = `Plan to fix the pooling compile errors

1. Run dotnet_build for the solution
2. Read the failing pooling files
3. Search the package for the missing types`;

    expect(buildAutonomyDeflectionGate(draft, evidence, "Show me the plan before you touch the code.")).toBeNull();
    expect(shouldRunCompletionReview(evidence, draft, "Show me the plan before you touch the code.")).toBe(false);
  });

  it("treats approve decisions with partial closure as still open", () => {
    expect(hasOpenReviewFindings({
      decision: "approve",
      summary: "The build fix landed, but the runtime freeze still has open hypotheses.",
      closureStatus: "partial",
      openInvestigations: ["ArrowInputSystem input path still needs profiler-backed verification."],
      reviews: {
        security: "clean",
        code: "clean",
        simplify: "clean",
      },
      logStatus: "clean",
    })).toBe(true);
  });

  it("keeps bare approve decisions open when the draft still leaves runtime investigations unresolved", () => {
    expect(hasOpenReviewFindingsForDraft({
      decision: "approve",
      summary: "The build fix landed cleanly.",
      reviews: {
        security: "clean",
        code: "clean",
        simplify: "clean",
      },
      logStatus: "clean",
    }, `Build successful. Remaining potential issues:
- ArrowInputSystem may still scan every arrow on input.
- If the freeze continues, inspect Unity Profiler CPU Usage and Call Stack.
DONE`)).toBe(true);
  });
});
