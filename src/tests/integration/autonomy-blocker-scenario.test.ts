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
    it("default thresholds allow 4 same-fingerprint events without triggering", () => {
      const tracker = new ControlLoopTracker(); // defaults: fpThreshold=5

      const event = {
        kind: "verifier_continue" as const,
        reason: "conformance gate still pending",
        gate: "[STRADA CONFORMANCE REQUIRED]",
        iteration: 1,
      };

      // 4 events — should NOT trigger with new default (was 3 before fix)
      for (let i = 1; i <= 4; i++) {
        const result = tracker.recordGate({ ...event, iteration: i });
        expect(result).toBeNull();
      }

      // 5th event — SHOULD trigger
      const trigger = tracker.recordGate({ ...event, iteration: 5 });
      expect(trigger).not.toBeNull();
      expect(trigger!.reason).toBe("same_fingerprint_repeated");
    });

    it("allows 7 mixed gate events without density trigger (old threshold was 5)", () => {
      const tracker = new ControlLoopTracker(); // defaults: densityThreshold=8

      const kinds = [
        "verifier_continue",
        "clarification_internal_continue",
        "visibility_internal_continue",
        "verifier_replan",
      ] as const;

      // 7 mixed events — should NOT trigger density (old threshold 5 would have)
      for (let i = 1; i <= 7; i++) {
        const result = tracker.recordGate({
          kind: kinds[i % kinds.length]!,
          reason: `reason-${i}`,
          iteration: i,
        });
        expect(result).toBeNull();
      }

      // 8th event — SHOULD trigger density
      const trigger = tracker.recordGate({
        kind: "verifier_continue",
        reason: "reason-8",
        iteration: 8,
      });
      expect(trigger).not.toBeNull();
      expect(trigger!.reason).toBe("internal_gate_density");
    });

    it("maxRecoveryEpisodes defaults to 5 (was ~2)", () => {
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
