/**
 * Integration test: Autonomy Blocker Scenario
 *
 * Simulates the exact bug where the agent got stuck editing game .cs files:
 * 1. Agent edits Assets/Game/LevelSolver.cs (game code, not framework code)
 * 2. Strada packages are installed (submodule present)
 * 3. Conformance guard should NOT trigger (game file, not framework file)
 * 4. Verifier pipeline should NOT inject conformance gate
 * 5. Control loop tracker should tolerate more iterations before blocking
 * 6. Daemon mode should prevent "blocked" decision
 */

import { describe, expect, it } from "vitest";
import { StradaConformanceGuard } from "../../agents/autonomy/strada-conformance.js";
import { SelfVerification } from "../../agents/autonomy/self-verification.js";
import { ControlLoopTracker } from "../../agents/autonomy/control-loop-tracker.js";
import { planVerifierPipeline } from "../../agents/autonomy/verifier-pipeline.js";
import { AgentPhase, type AgentState } from "../../agents/agent-state.js";
import {
  LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT,
  buildLoopRecoveryReviewRequest,
} from "../../agents/autonomy/loop-recovery-review.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { DaemonSecurityPolicy } from "../../daemon/security/daemon-security-policy.js";

const STRADA_DEPS = {
  coreInstalled: true,
  corePath: "Packages/com.strada.core",
  modulesInstalled: true,
  modulesPath: "Packages/com.strada.modules",
  mcpInstalled: false,
  mcpPath: null,
  mcpVersion: null,
  warnings: [],
} as const;

const GAME_FILES = [
  "Assets/Game/LevelEditor/Runtime/Services/LevelSolver.cs",
  "Assets/Game/LevelEditor/Runtime/Services/PatternGenerator.cs",
  "Assets/Game/LevelEditor/Runtime/Services/DifficultyCalculator.cs",
  "Assets/Game/LevelEditor/Editor/Windows/UnifiedLevelGeneratorWindow.cs",
  "Assets/Game/Modules/GameCore/Systems/ArrowInputSystem.cs",
  "Assets/Game/Modules/GameCore/Systems/ArrowMovementSystem.cs",
];

const FRAMEWORK_FILES = [
  "Packages/com.strada.core/Runtime/Systems/BaseSystem.cs",
  "Packages/com.strada.modules/Runtime/Mediators/UIMediator.cs",
];

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Fix the level editor freeze bug",
    iteration: 5,
    plan: "Edit LevelSolver and PatternGenerator to fix the freeze",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

describe("Autonomy Blocker Scenario — Game .cs File Editing", () => {
  describe("Scenario 1: The exact bug — editing game files with Strada installed", () => {
    it("conformance guard does NOT trigger when editing game .cs files (the fix)", () => {
      const guard = new StradaConformanceGuard(STRADA_DEPS);

      // Agent edits multiple game files
      for (const file of GAME_FILES) {
        guard.trackToolCall("file_edit", { path: file }, false, "ok");
      }

      // Agent reads game files (not Strada package files)
      guard.trackToolCall("file_read", { path: "Assets/Game/LevelEditor/Runtime/Data/LevelData.cs" }, false, "");
      guard.trackToolCall("grep_search", { pattern: "LevelSolver", path: "Assets/Game" }, false, "matches");

      // Conformance should NOT trigger — these are game files, not framework files
      expect(guard.needsConformanceReview()).toBe(false);
      expect(guard.getPrompt()).toBeNull();
    });

    it("conformance guard DOES trigger when editing actual framework files", () => {
      const guard = new StradaConformanceGuard(STRADA_DEPS);

      // Agent edits a file inside Strada.Core package
      guard.trackToolCall("file_edit", { path: FRAMEWORK_FILES[0]! }, false, "ok");

      // Without consulting authoritative source → should trigger
      expect(guard.needsConformanceReview()).toBe(true);
      expect(guard.getPrompt()).toContain("[STRADA CONFORMANCE REQUIRED]");

      // After reading from framework package → should clear
      guard.trackToolCall("file_read", { path: "Packages/com.strada.core/README.md" }, false, "docs");
      expect(guard.needsConformanceReview()).toBe(false);
    });

    it("verifier pipeline does NOT inject conformance gate for game files", () => {
      const guard = new StradaConformanceGuard(STRADA_DEPS);
      const selfVerification = new SelfVerification();

      // Simulate: agent edited game files, ran build, build passed
      for (const file of GAME_FILES) {
        guard.trackToolCall("file_edit", { path: file }, false, "ok");
        selfVerification.track("file_edit", { path: file }, { toolCallId: "t1", content: "ok", isError: false });
      }
      selfVerification.track("dotnet_build", {}, { toolCallId: "t2", content: "Build succeeded", isError: false });

      const conformanceGate = guard.getPrompt();
      const buildGate = selfVerification.needsVerification() ? selfVerification.getPrompt() : null;

      // Both gates should be null
      expect(conformanceGate).toBeNull();
      expect(buildGate).toBeNull();

      // Verifier pipeline should approve (no gating checks)
      const plan = planVerifierPipeline({
        prompt: "Fix the level editor freeze",
        draft: "Fixed LevelSolver and PatternGenerator. Build passes.\nDONE",
        state: createState(),
        task: { type: "implementation", complexity: "moderate", criticality: "medium" },
        verificationState: selfVerification.getState(),
        buildVerificationGate: buildGate,
        conformanceGate,
        logEntries: [],
        chatId: "test-scenario",
        taskStartedAtMs: Date.now() - 5000,
      });

      // Should NOT have gating checks, should not require review for simple done
      const conformanceCheck = plan.checks.find((c) => c.name === "conformance");
      expect(conformanceCheck?.status).not.toBe("issues");
      expect(plan.summary).not.toContain("Static verifier checks still require more work");
    });
  });

  describe("Scenario 2: Control loop tracker tolerance", () => {
    it("default thresholds allow 14 same-fingerprint events without triggering", () => {
      // Disable stale analysis to isolate fingerprint behavior
      const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });

      const event = {
        kind: "verifier_continue" as const,
        reason: "conformance gate still pending",
        gate: "[STRADA CONFORMANCE REQUIRED]",
        iteration: 1,
      };

      // 14 events — should NOT trigger (default fpThreshold=15)
      for (let i = 1; i <= 14; i++) {
        const result = tracker.recordGate({ ...event, iteration: i });
        expect(result).toBeNull();
      }

      // 15th event — SHOULD trigger
      const trigger = tracker.recordGate({ ...event, iteration: 15 });
      expect(trigger).not.toBeNull();
      expect(trigger!.reason).toBe("same_fingerprint_repeated");
    });

    it("allows 19 mixed gate events without density trigger", () => {
      // Disable stale analysis to isolate density behavior
      const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });

      const kinds = [
        "verifier_continue",
        "clarification_internal_continue",
        "visibility_internal_continue",
        "verifier_replan",
      ] as const;

      // 19 mixed events — should NOT trigger density (default=20)
      for (let i = 1; i <= 19; i++) {
        const result = tracker.recordGate({
          kind: kinds[i % kinds.length]!,
          reason: `reason-${i}`,
          iteration: i,
        });
        expect(result).toBeNull();
      }

      // 20th event — SHOULD trigger density
      const trigger = tracker.recordGate({
        kind: "verifier_continue",
        reason: "reason-20",
        iteration: 20,
      });
      expect(trigger).not.toBeNull();
      expect(trigger!.reason).toBe("internal_gate_density");
    });

    it("stale analysis triggers after 10 consecutive gates without tool execution", () => {
      const tracker = new ControlLoopTracker();

      for (let i = 1; i <= 9; i++) {
        expect(tracker.recordGate({
          kind: "clarification_internal_continue",
          reason: "Clarification kept internal",
          iteration: i,
        })).toBeNull();
      }

      const trigger = tracker.recordGate({
        kind: "clarification_internal_continue",
        reason: "Clarification kept internal",
        iteration: 10,
      });
      expect(trigger).not.toBeNull();
      expect(trigger!.reason).toBe("stale_analysis_loop");
    });

    it("maxRecoveryEpisodes defaults to 5", () => {
      const tracker = new ControlLoopTracker();
      expect(tracker.maxRecoveryEpisodes).toBe(5);
    });
  });

  describe("Scenario 3: Daemon mode blocked prevention", () => {
    it("loop recovery review system prompt discourages blocked in daemon mode", () => {
      expect(LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT).toContain("absolute last resort");
      expect(LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT).toContain("daemon or autonomous mode");
      expect(LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT).toContain("strongly prefer replan_local");
    });

    it("buildLoopRecoveryReviewRequest includes daemon context", () => {
      const request = buildLoopRecoveryReviewRequest(
        {
          fingerprint: "verifier_continue:conformance_gate",
          recoveryEpisode: 3,
          requiredActions: ["Run verification"],
          recentToolSummaries: ["file_edit: ok"],
          touchedFiles: ["Assets/Game/LevelSolver.cs"],
          recentUserFacingProgress: [],
          availableDelegations: ["delegate_code_review"],
        },
        { daemonMode: true, maxRecoveryEpisodes: 5 },
      );

      expect(request).toContain("Daemon/autonomous mode: YES");
      expect(request).toContain("Max recovery episodes: 5");
      expect(request).toContain("prefer replan over blocked");
    });
  });

  describe("Scenario 4: Full autonomy mode", () => {
    it("DaemonSecurityPolicy allows all tools with fullAutonomy=true", () => {
      const lookup = (name: string) => {
        const map: Record<string, { readOnly: boolean }> = {
          file_read: { readOnly: true },
          file_write: { readOnly: false },
          shell_exec: { readOnly: false },
          git_commit: { readOnly: false },
          git_push: { readOnly: false },
        };
        return map[name];
      };

      // Mock approval queue
      const queue = {
        enqueue: () => ({ id: "1", toolName: "", params: {}, status: "pending" as const, createdAt: Date.now(), expiresAt: Date.now() + 60000 }),
        approve: () => {},
        deny: () => {},
        getPending: () => [],
        expireStale: () => 0,
      };

      const policy = new DaemonSecurityPolicy(lookup, queue as never, new Set(), true);

      // ALL tools should be allowed — including ALWAYS_QUEUE_TOOLS
      expect(policy.checkPermission("file_write")).toBe("allow");
      expect(policy.checkPermission("shell_exec")).toBe("allow");
      expect(policy.checkPermission("git_commit")).toBe("allow");
      expect(policy.checkPermission("git_push")).toBe("allow");
      expect(policy.checkPermission("file_read")).toBe("allow");
      expect(policy.checkPermission("unknown_tool")).toBe("allow");
    });

    it("DaemonSecurityPolicy queues write tools with fullAutonomy=false (default)", () => {
      const lookup = (name: string) => {
        if (name === "file_write") return { readOnly: false };
        return undefined;
      };

      const queue = {
        enqueue: () => ({ id: "1", toolName: "", params: {}, status: "pending" as const, createdAt: Date.now(), expiresAt: Date.now() + 60000 }),
        approve: () => {},
        deny: () => {},
        getPending: () => [],
        expireStale: () => 0,
      };

      const policy = new DaemonSecurityPolicy(lookup, queue as never, new Set(), false);
      expect(policy.checkPermission("file_write")).toBe("queue");
    });
  });

  describe("Scenario 5: createAutonomyBundle wiring", () => {
    it("passes conformance options through to StradaConformanceGuard", () => {
      const bundle = createAutonomyBundle({
        prompt: "Fix game bug",
        iterationBudget: 50,
        stradaDeps: STRADA_DEPS,
        conformanceEnabled: true,
        conformanceFrameworkPathsOnly: true,
        includeControlLoopTracker: true,
        loopFingerprintThreshold: 10,
        loopFingerprintWindow: 30,
        loopDensityThreshold: 15,
        loopDensityWindow: 50,
        loopMaxRecoveryEpisodes: 8,
        loopStaleAnalysisThreshold: 100, // disable stale analysis for this test
      });

      // Conformance: editing game file should NOT trigger
      bundle.stradaConformance.trackToolCall("file_edit", { path: "Assets/Game/Foo.cs" }, false, "");
      expect(bundle.stradaConformance.needsConformanceReview()).toBe(false);

      // Control loop: custom thresholds wired through
      expect(bundle.controlLoopTracker).not.toBeNull();
      expect(bundle.controlLoopTracker!.maxRecoveryEpisodes).toBe(8);

      // 9 same fingerprint events should NOT trigger (threshold=10)
      for (let i = 1; i <= 9; i++) {
        expect(
          bundle.controlLoopTracker!.recordGate({
            kind: "verifier_continue",
            reason: "test",
            iteration: i,
          }),
        ).toBeNull();
      }
      // 10th should trigger
      expect(
        bundle.controlLoopTracker!.recordGate({
          kind: "verifier_continue",
          reason: "test",
          iteration: 10,
        }),
      ).not.toBeNull();
    });

    it("C# editing without dotnet_build does not produce blocking gate", () => {
      const selfVerification = new SelfVerification();

      // Agent edits game C# files — no dotnet_build available
      for (const file of GAME_FILES) {
        selfVerification.track("file_edit", { path: file }, { toolCallId: "t1", content: "ok", isError: false });
      }

      const verificationState = selfVerification.getState();
      expect(verificationState.hasCompilableChanges).toBe(true);

      // Simulate: only shell_exec available, no dotnet_build/dotnet_test
      // This means buildToolsAvailable should be false for compilable changes
      const plan = planVerifierPipeline({
        prompt: "Fix ArrowMovementSystem freeze",
        draft: "Fixed ArrowMovementSystem.cs and ArrowInputSystem.cs.\nDONE",
        state: createState({
          stepResults: [
            { toolName: "file_read", success: true, summary: "Read ArrowMovementSystem.cs", timestamp: Date.now() - 500 },
            { toolName: "file_edit", success: true, summary: "Updated ArrowMovementSystem.cs", timestamp: Date.now() - 400 },
            { toolName: "file_read", success: true, summary: "Read ArrowInputSystem.cs", timestamp: Date.now() - 300 },
            { toolName: "file_edit", success: true, summary: "Updated ArrowInputSystem.cs", timestamp: Date.now() - 200 },
          ],
        }),
        task: { type: "implementation", complexity: "moderate", criticality: "medium" },
        verificationState,
        buildVerificationGate: selfVerification.needsVerification() ? selfVerification.getPrompt() : null,
        conformanceGate: null,
        logEntries: [
          { timestamp: new Date().toISOString(), level: "warn", message: "Unity project not in build path", meta: { chatId: "test-cs" } },
        ],
        chatId: "test-cs",
        taskStartedAtMs: Date.now() - 5000,
        buildToolsAvailable: false, // no dotnet_build in tool list
      });

      // Build check should be not_applicable
      const buildCheck = plan.checks.find(c => c.name === "build");
      expect(buildCheck?.status).toBe("not_applicable");

      // Targeted-repro check should be skipped entirely
      const targetedCheck = plan.checks.find(c => c.name === "targeted-repro");
      expect(targetedCheck).toBeUndefined();

      // No gating checks should block
      const gatingChecks = plan.checks.filter(c => c.gate);
      expect(gatingChecks).toHaveLength(0);

      // buildToolsAvailable should be exposed on the plan
      expect(plan.buildToolsAvailable).toBe(false);
    });

    it("disabled conformance never triggers even for framework files", () => {
      const bundle = createAutonomyBundle({
        prompt: "Fix framework bug",
        iterationBudget: 50,
        stradaDeps: STRADA_DEPS,
        conformanceEnabled: false,
      });

      bundle.stradaConformance.trackToolCall("file_edit", { path: "Packages/com.strada.core/Runtime/Foo.cs" }, false, "");
      expect(bundle.stradaConformance.needsConformanceReview()).toBe(false);
    });
  });
});
