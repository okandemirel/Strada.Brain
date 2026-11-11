import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import {
  buildAutonomyDeflectionGate,
  buildCompletionReviewRequest,
  collectCompletionReviewEvidence,
  hasOpenReviewFindingsForDraft,
  mergeCompletionReviewDecisionWithStages,
  parseCompletionReviewStageResult,
  shouldRunCompletionReview,
  userExplicitlyAskedForCompletionReview,
  userExplicitlyAskedForPlan,
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

  it("judges a log line against the cutoff by its millisecond stamp, never by its floored second", () => {
    // The ring buffer's string is the file format, second resolution. Read as
    // a time, both lines below fell before the cutoff (the second floors to
    // .000), so a warning logged after the cutoff in the same second was lost,
    // and the same warning a second later counted: the verdict moved with the
    // clock. Both directions are pinned, 1 ms either side of the cutoff.
    const second = "2026-03-18 10:00:10";
    const cutoff = Date.parse(second) + 500;
    const line = (message: string, timestampMs: number) => ({
      timestamp: second, timestampMs, level: "warn", message, meta: { chatId: "chat-123" },
    });
    const evidence = collectCompletionReviewEvidence({
      state: createState(),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: cutoff,
      },
      chatId: "chat-123",
      taskStartedAtMs: cutoff - 5_000,
      logEntries: [line("1 ms before the cutoff", cutoff - 1), line("1 ms after the cutoff", cutoff + 1)],
    });

    expect(evidence.recentLogIssues.map((entry) => entry.message)).toEqual(["1 ms after the cutoff"]);
  });

  it("drops a provider failure a later step answered, and keeps one nothing succeeded after", () => {
    // Measured 2026-11-11 (golden run, recovery): two dropped provider calls,
    // then the next turn wrote the file. The drops are the provider's failure,
    // not the work's, and a later step proves the provider answered again; a
    // drop with no success after it may be what the answer rests on.
    const dropAt = Date.parse("2026-03-18T10:00:20.000Z");
    const drop = (message: string) => ({
      timestamp: "2026-03-18 10:00:20", timestampMs: dropAt, level: "error", message,
      meta: { chatId: "chat-123", error: "503 Service Unavailable" },
    });
    const logEntries = [
      drop("Silent stream error"),
      drop("Silent stream fallback chat failed"),
      drop("Tool handler crashed"),
    ];
    const collect = (stepAt: number, success: boolean) => collectCompletionReviewEvidence({
      state: createState({
        stepResults: [{ toolName: "file_write", success, summary: "Wrote notes/b.txt", timestamp: stepAt }],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["notes/b.txt"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
      },
      chatId: "chat-123",
      taskStartedAtMs: dropAt - 5_000,
      logEntries,
    }).recentLogIssues.map((entry) => entry.message);

    // Answered: a step succeeded after the drop. Any other error still counts.
    expect(collect(dropAt + 1, true)).toEqual(["Tool handler crashed"]);
    // Not answered: the only success came before the drop, or the step after it failed.
    const unanswered = ["Silent stream error", "Silent stream fallback chat failed", "Tool handler crashed"];
    expect(collect(dropAt - 1, true)).toEqual(unanswered);
    expect(collect(dropAt + 1, false)).toEqual(unanswered);
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
    expect(gate).toContain("internal execution plan, tool checklist, or intake checklist");
  });

  it("builds an autonomy gate for internal tool-directed checklists even without a plan heading", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "memory_search", success: true, summary: "Searched prior conversation memory", timestamp: Date.now() - 500 },
          { toolName: "git_log", success: true, summary: "Reviewed recent commits", timestamp: Date.now() - 250 },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-tool-checklist",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const gate = buildAutonomyDeflectionGate(
      `PLAN
Bellek taramasi yap: memory_search ile son oturumu ara.
Proje durumunu dogrula: git_log ve git_status ile son degisikliklere bak.
Gerekirse grep_search ile ilgili modulu teyit et.
Belirsizlik varsa ask_user ile tek bir soru sor ve show_plan ile onaylat.`,
      evidence,
    );

    expect(gate).toContain("[AUTONOMY REQUIRED]");
    expect(gate).toContain("tool checklist");
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

  it("skips completion review for low-risk non-code mutation footprints", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Temp", timestamp: Date.now() - 500 },
          { toolName: "file_write", success: true, summary: "Wrote Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 250 },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Temp/strada_autonomy_smoke.txt"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-low-risk-mutation",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    expect(shouldRunCompletionReview(evidence, "tamam")).toBe(false);
  });

  it("skips completion review for bounded shell-based Temp mutations", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Temp", timestamp: Date.now() - 900 },
          { toolName: "shell_exec", success: true, summary: "Touched Temp workspace", timestamp: Date.now() - 750 },
          { toolName: "glob_search", success: true, summary: "Matched strada_autonomy_smoke.txt", timestamp: Date.now() - 600 },
          { toolName: "file_write", success: true, summary: "Wrote Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 450 },
          { toolName: "file_read", success: true, summary: "Read Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 300 },
          { toolName: "file_delete", success: true, summary: "Deleted Temp/strada_autonomy_smoke.txt", timestamp: Date.now() - 150 },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Temp/strada_autonomy_smoke.txt"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-low-risk-shell-mutation",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const prompt = "Temp altında `strada_autonomy_smoke.txt` oluştur, içine `autonomy ok` yaz, sonra dosyayı oku ve sil.";
    expect(shouldRunCompletionReview(evidence, "Temp görevini tamamladım.", prompt)).toBe(false);
  });

  it("keeps completion review when the user explicitly requires final review before finishing", () => {
    const evidence = collectCompletionReviewEvidence({
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed docs", timestamp: Date.now() - 500 },
          { toolName: "file_write", success: true, summary: "Wrote docs/result.md", timestamp: Date.now() - 250 },
        ],
      }),
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["docs/result.md"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      chatId: "chat-review-requested",
      taskStartedAtMs: Date.now() - 1000,
      logEntries: [],
    });

    const prompt = "Produce the result artifact and finish only after full review";
    expect(userExplicitlyAskedForCompletionReview(prompt)).toBe(true);
    expect(shouldRunCompletionReview(evidence, "Result finalized.", prompt)).toBe(true);
  });

  it("does not treat generic execution-plan discussion as an explicit plan-review request", () => {
    expect(userExplicitlyAskedForPlan("Why did this execution plan fail?")).toBe(false);
    expect(userExplicitlyAskedForPlan("Can you explain the execution plan you used yesterday?")).toBe(false);
  });



});
