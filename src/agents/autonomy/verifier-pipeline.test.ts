import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import {
  isTerminalFailureReport,
  planVerifierPipeline,
} from "./verifier-pipeline.js";

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Investigate the Unity level issue",
    iteration: 2,
    plan: "Inspect the relevant asset and verify the real failure path",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

const DEBUG_TASK = {
  type: "debugging",
  complexity: "complex",
  criticality: "high",
} as const;

const IMPLEMENTATION_TASK = {
  type: "implementation",
  complexity: "moderate",
  criticality: "medium",
} as const;

describe("verifier-pipeline", () => {
  it("continues when compilable changes still need clean verification", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the runtime error",
      draft: "All fixed.\nDONE",
      state: createState(),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(["src/runtime/reviewer.ts"]),
        touchedFiles: new Set(["src/runtime/reviewer.ts"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: "[VERIFICATION REQUIRED] Run the relevant verification.",
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-build",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[VERIFIER PIPELINE]");
    expect(plan.gate).toContain("build");
  });

  it("continues when a failing path still lacks targeted verification", () => {
    const plan = planVerifierPipeline({
      prompt: "Analyze why the Unity editor crashed",
      draft: "All 100 levels analyzed.\nDONE",
      state: createState({
        stepResults: [
          { toolName: "list_directory", success: true, summary: "Listed Assets/Resources/Levels", timestamp: Date.now() - 500 },
          { toolName: "file_read", success: false, summary: "Level_031.asset not found", timestamp: Date.now() - 250 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Assets/Resources/Levels/Level_031.asset"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-repro",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[VERIFIER PIPELINE]");
    expect(plan.gate).toContain("targeted-repro");
  });

  it("approves honest terminal blocker drafts without forcing another review pass", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the broken asset",
      draft: "The asset is missing and the task is blocked until the user restores it.",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: false, summary: "Asset missing", timestamp: Date.now() - 100 },
        ],
      }),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-blocked",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.evidence.hasTerminalFailureReport).toBe(true);
    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("approve");
  });

  it("approves bounded Temp shell tasks without forcing completion review", () => {
    const plan = planVerifierPipeline({
      prompt: "Temp altında `strada_autonomy_smoke.txt` oluştur, içine `autonomy ok` yaz, sonra dosyayı oku ve sil.",
      draft: "Temp görevini tamamladım.",
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
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Temp/strada_autonomy_smoke.txt"]),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-temp-shell",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.reviewRequired).toBe(false);
    expect(plan.initialDecision).toBe("approve");
    expect(plan.summary).toContain("No additional verifier review");
  });

  it("keeps the pipeline open for a draft that declares done and leaves its own questions open", () => {
    const plan = planVerifierPipeline({
      prompt: "Fix the runtime issue and keep going until the real issue is verified",
      draft: `Build successful. Strada.Core compatible fixes are complete.

Remaining potential issues:
- ArrowInputSystem may still scan every arrow on input.
- If the freeze continues, inspect Unity Profiler CPU Usage and Call Stack.
DONE`,
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
          { toolName: "file_read", success: true, summary: "Read GameRenderer.cs", timestamp: Date.now() - 200 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-debug-review",
      taskStartedAtMs: Date.now() - 1000,
    });

    // The four LLM review stages used to decide this. What they were catching is
    // a property of the text — a completion claim beside open investigations —
    // and draftLeavesOpenInvestigations reads it without a model call.
    expect(plan.initialDecision).toBe("continue");
    expect(plan.reviewRequired).toBe(false);
    expect(plan.gate).toMatch(/investigations|unresolved/i);
  });



  it("asks for a replan when the same error keeps coming back", () => {
    // "Replan" used to arrive only as an LLM review verdict. The deterministic
    // equivalent was already here and unread: the same-error check exists to say
    // the current approach is not working, which is what a replan is.
    const sameFailure = {
      toolName: "dotnet_build",
      success: false,
      summary: "error CS0103: the name 'Foo' does not exist in the current context",
      timestamp: Date.now(),
    };
    const plan = planVerifierPipeline({
      prompt: "Fix the build error",
      draft: "Fixed it.\nDONE",
      state: createState({
        stepResults: [
          { ...sameFailure, timestamp: Date.now() - 300 },
          { ...sameFailure, timestamp: Date.now() - 200 },
          { ...sameFailure, timestamp: Date.now() - 100 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Assets/A.cs"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 50,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-same-error",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.initialDecision).toBe("replan");
    expect(plan.gate).toContain("REPLAN REQUIRED");
  });

  it("hard-blocks completion when build tools are unavailable but verification debt is outstanding", () => {
    // The old behavior collapsed missing tooling to not_applicable, which let
    // a disconnected Unity bridge delete the build gate and approve unverified
    // compilable changes (how PixelFlow milestones went green on UNKNOWN).
    const plan = planVerifierPipeline({
      prompt: "fix the level editor",
      draft: "I updated the ArrowLevelEditorWindow.cs file to fix the issue.",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowLevelEditorWindow.cs", timestamp: Date.now() - 300 },
          { toolName: "file_edit", success: true, summary: "Updated ArrowLevelEditorWindow.cs", timestamp: Date.now() - 100 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(["Assets/Editor/ArrowLevelEditorWindow.cs"]),
        touchedFiles: new Set(["Assets/Editor/ArrowLevelEditorWindow.cs"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: "[VERIFICATION REQUIRED] Run build",
      conformanceGate: null,
      logEntries: [],
      chatId: "test-build-tools",
      taskStartedAtMs: Date.now() - 1000,
      buildToolsAvailable: false,
    });

    const buildCheck = plan.checks.find(c => c.name === "build");
    expect(buildCheck?.status).toBe("issues");
    expect(buildCheck?.gate).toContain("VERIFICATION TOOLING UNAVAILABLE");
    expect(plan.initialDecision).toBe("continue");
  });

  it("stays not_applicable without verification debt, and lets an honest blocked report through", () => {
    const base = {
      prompt: "fix the level editor",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read file", timestamp: Date.now() - 300 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      conformanceGate: null,
      logEntries: [],
      chatId: "test-build-tools-2",
      taskStartedAtMs: Date.now() - 1000,
      buildToolsAvailable: false,
    } as const;

    // No compilable debt → genuinely nothing to verify.
    const noDebt = planVerifierPipeline({
      ...base,
      draft: "Investigated and documented the findings.",
      verificationState: {
        pendingFiles: new Set<string>(),
        touchedFiles: new Set<string>(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
    });
    expect(noDebt.checks.find(c => c.name === "build")?.status).toBe("not_applicable");

    // Debt + an honest terminal failure report → recorded as issues, but no
    // gate: the honest blocked report is the accepted exit.
    const honest = planVerifierPipeline({
      ...base,
      draft: "Blocked: the Unity bridge is down, so the compile could not run. The change to Foo.cs remains unverified.",
      verificationState: {
        pendingFiles: new Set(["Assets/Foo.cs"]),
        touchedFiles: new Set(["Assets/Foo.cs"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: "[VERIFICATION REQUIRED] Run build",
    });
    const honestBuild = honest.checks.find(c => c.name === "build");
    expect(honestBuild?.status).toBe("issues");
    expect(honestBuild?.gate).toBeUndefined();
  });

  it("exposes buildToolsAvailable on the plan when explicitly set", () => {
    const plan = planVerifierPipeline({
      prompt: "fix arrow input",
      draft: "Fixed ArrowInputSystem.cs.\nDONE",
      state: createState({
        stepResults: [
          { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
          { toolName: "file_edit", success: true, summary: "Updated ArrowInputSystem.cs", timestamp: Date.now() - 100 },
        ],
      }),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(["Assets/Game/Systems/ArrowInputSystem.cs"]),
        touchedFiles: new Set(["Assets/Game/Systems/ArrowInputSystem.cs"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
        lastVerificationAt: null,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "test-expose",
      taskStartedAtMs: Date.now() - 1000,
      buildToolsAvailable: false,
    });

    expect(plan.buildToolsAvailable).toBe(false);
  });

  it("exposes buildToolsAvailable as undefined when not explicitly set", () => {
    const plan = planVerifierPipeline({
      prompt: "fix runtime issue",
      draft: "All fixed.\nDONE",
      state: createState(),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["src/utils/helpers.ts"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 200,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "test-default",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.buildToolsAvailable).toBeUndefined();
  });


  it("carries an unassembled-game gate through to a blocking check", () => {
    // The end of the chain: StradaConformanceGuard opens the gate, the pipeline
    // has to turn it into an issue rather than let the draft's DONE stand.
    const plan = planVerifierPipeline({
      prompt: "Build the board module",
      draft: "Nine modules created and compiling.\nDONE",
      state: createState(),
      task: DEBUG_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      buildVerificationGate: null,
      conformanceGate:
        "[STRADA GAME NOT ASSEMBLED] This run wrote module code but the project is not a runnable game: no .unity scene was produced.",
      logEntries: [],
      chatId: "chat-scene",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.initialDecision).not.toBe("complete");
    expect(plan.gate).toContain("GAME NOT ASSEMBLED");
    // The summary names the gate that is actually open. It used to say every
    // gate "needs authoritative verification", which sends a run missing a
    // scene to read Strada.Core source instead.
    expect(plan.gate).not.toContain("authoritative verification");
  });

  it("refuses a completion that walks past deliverables the task named", () => {
    const plan = planVerifierPipeline({
      prompt: [
        "Continue building the game.",
        "- Power-ups: 0 files. Implement them as the GDD specifies.",
        "- Lose condition: 0 files. A game you cannot lose is not the game.",
        "- A PlayMode test that plays a level to a win, and one to a loss.",
      ].join("\n"),
      draft: "Done. The lose condition is implemented and verified.",
      state: createState(),
      task: IMPLEMENTATION_TASK,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(["Assets/Modules/GameFlow/LoseCondition.cs"]),
        hasCompilableChanges: false,
        lastBuildOk: true,
        lastVerificationAt: Date.now() - 100,
      },
      buildVerificationGate: null,
      conformanceGate: null,
      logEntries: [],
      chatId: "chat-deliverables",
      taskStartedAtMs: Date.now() - 1000,
    });

    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("Power-ups");
    expect(plan.gate).toContain("PlayMode test");
    expect(plan.gate).not.toContain("Lose condition");
  });

  /**
   * Audited 2026-09-02: the failure vocabulary included "missing", "requires",
   * "not found", "error" and "failure" — words an ordinary completion report
   * uses about things it FIXED — while "implemented" was not a success word.
   * "Done. Implemented … The pig prefab was missing, so I generated one." was
   * therefore approved as an honest terminal failure report (skipping the
   * deliverables review and, with build tools unavailable, downgrading the
   * build gate), and campaign-manager recorded the same sprint as failed.
   */
  describe("isTerminalFailureReport reads the run's own outcome, not its vocabulary", () => {
    it.each([
      "Done. Implemented ScoreService, BoardView and the level loader. The pig prefab was missing, so I generated one.",
      "All three systems are implemented and the PlayMode tests pass. I removed a stale reference that caused a compile error.",
      "Wired the HUD. Nothing is missing now.",
      "The build requires Unity 2022.3, which the project uses. Shipped the level loader.",
    ])("does not read a completion draft as a failure report: %s", (draft) => {
      expect(isTerminalFailureReport(draft)).toBe(false);
    });

    it.each([
      "The asset is missing and the task is blocked until the user restores it.",
      "Unable to run PlayMode: the Unity bridge is down and cannot be restored from here.",
      "The headless compile timed out three times; manual intervention is needed.",
    ])("still recognises an honest blocker: %s", (draft) => {
      expect(isTerminalFailureReport(draft)).toBe(true);
    });

    it("does not approve a completion draft as an honest failure report", () => {
      const plan = planVerifierPipeline({
        prompt: "Implement ScoreService, BoardView, the level loader and PowerUps",
        draft: "Done. Implemented ScoreService, BoardView and the level loader. The pig prefab was missing, so I generated one.",
        state: createState(),
        task: IMPLEMENTATION_TASK,
        verificationState: {
          pendingFiles: new Set(),
          touchedFiles: new Set(["Assets/Scripts/ScoreService.cs"]),
          hasCompilableChanges: false,
          lastBuildOk: true,
          lastVerificationAt: Date.now() - 500,
        },
        buildVerificationGate: null,
        conformanceGate: null,
        logEntries: [],
        chatId: "chat-vocab",
        taskStartedAtMs: Date.now() - 1000,
      });

      expect(plan.evidence.hasTerminalFailureReport).toBe(false);
      expect(plan.summary).not.toContain("honest terminal failure report");
    });
  });
});
