import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.ts";
import { RuntimeArtifactManager } from "./runtime-artifact-manager.ts";
import type { Instinct, RuntimeArtifact } from "./types.ts";
import type { TimestampMs } from "../types/index.js";

describe("RuntimeArtifactManager", () => {
  let tempDir: string;
  let storage: LearningStorage;
  let manager: RuntimeArtifactManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "runtime-artifacts-"));
    storage = new LearningStorage(join(tempDir, "learning.db"));
    storage.initialize();
    manager = new RuntimeArtifactManager(storage);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("materializes workflow and knowledge patch artifacts with aligned evolution proposals", () => {
    const workflowInstinct = createInstinct({
      id: "instinct_workflow",
      type: "tool_usage",
      triggerPattern: "build and verify pooling fix",
      action: JSON.stringify({
        description: "read compile errors, inspect pooling files, run dotnet build",
        toolSequence: ["file_read", "grep_search", "dotnet_build"],
      }),
      sourceTrajectoryIds: ["traj_workflow" as any],
      contextConditions: [{ id: "ctx_workflow" as any, type: "tool_name", value: "dotnet_build", match: "include" }],
    });
    const knowledgeInstinct = createInstinct({
      id: "instinct_knowledge",
      type: "correction",
      triggerPattern: "provider capability mismatch in setup",
      action: "Correct provider setup guidance when embedding-capable workers are missing.",
      contextConditions: [{ id: "ctx_knowledge" as any, type: "project_type", value: "unity", match: "include" }],
    });

    storage.createInstinct(workflowInstinct);
    storage.createInstinct(knowledgeInstinct);

    const workflow = manager.materializeShadowArtifact(workflowInstinct);
    const knowledge = manager.materializeShadowArtifact(knowledgeInstinct);

    expect(workflow.artifact.kind).toBe("workflow");
    expect(knowledge.artifact.kind).toBe("knowledge_patch");
    expect(storage.getEvolutionProposals({ instinctId: workflowInstinct.id })[0]).toEqual(
      expect.objectContaining({
        targetType: "workflow",
        affectedTrajectoryIds: ["traj_workflow"],
      }),
    );
    expect(storage.getEvolutionProposals({ instinctId: knowledgeInstinct.id })[0]?.targetType).toBe("knowledge_patch");
  });

  it("matches artifacts by task type, project/world scope, and tool availability", () => {
    const artifact: RuntimeArtifact = {
      id: "artifact_debugging" as RuntimeArtifact["id"],
      kind: "workflow",
      state: "active",
      name: "Compile Fix Flow",
      description: "Use compile errors to drive the fix loop.",
      guidance: "Read compiler output, inspect failing files, and rerun dotnet build after each patch.",
      taskTypes: ["debugging"],
      taskPatterns: ["compile", "pooling", "cs0246", "build"],
      projectWorldFingerprint: "unity:pooling",
      requiredToolNames: ["dotnet_build", "file_read"],
      requiredCapabilities: ["tool-calling"],
      sourceInstinctIds: ["instinct_src" as any],
      sourceTrajectoryIds: [],
      stats: {
        shadowSampleCount: 5,
        activeUseCount: 5,
        cleanCount: 5,
        retryCount: 0,
        failureCount: 0,
        blockerCount: 0,
        harmfulCount: 0,
        recentEvaluations: [],
        regressionFingerprints: {},
      },
      promotedAt: Date.now() as TimestampMs,
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
    };
    storage.upsertRuntimeArtifact(artifact);

    const match = manager.matchForTask({
      taskDescription: "Fix the pooling compile error and rerun the build",
      taskType: "debugging",
      projectWorldFingerprint: "unity:pooling",
      availableToolNames: ["file_read", "dotnet_build"],
    });

    expect(match.active).toHaveLength(1);
    expect(match.active[0]?.usableForExecutionGuidance).toBe(true);

    const mismatch = manager.matchForTask({
      taskDescription: "Translate this README into French",
      taskType: "simple-question",
      projectWorldFingerprint: "docs:readme",
      availableToolNames: ["file_read"],
    });
    expect(mismatch.active).toHaveLength(0);
  });

  it("promotes shadow artifacts after verifier-clean shadow samples", () => {
    const instinct = createInstinct({
      id: "instinct_promote",
      type: "tool_usage",
      triggerPattern: "fix pooling compile error",
      action: "Run read -> patch -> build loop",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    for (let i = 0; i < 5; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        verdict: "clean",
        blocker: false,
        reason: "Verifier clean.",
      });
    }

    expect(storage.getRuntimeArtifact(artifact.id)?.state).toBe("active");
  });

  it("does not treat repeated clean evaluations as regressions", () => {
    const instinct = createInstinct({
      id: "instinct_clean",
      type: "tool_usage",
      triggerPattern: "stable verifier-approved workflow",
      action: "Read files and rerun dotnet build",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    for (let i = 0; i < 5; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        verdict: "clean",
        blocker: false,
        reason: "Verifier clean result repeated.",
        failureFingerprint: "should-not-count",
      });
    }

    const promoted = storage.getRuntimeArtifact(artifact.id);
    expect(promoted?.state).toBe("active");
    expect(promoted?.stats.regressionFingerprints).toEqual({});
  });

  it("starts a fresh shadow artifact after a rejected artifact instead of reusing terminal state", () => {
    const instinct = createInstinct({
      id: "instinct_retry",
      type: "correction",
      triggerPattern: "retry runtime artifact after rejection",
      action: "Use a safer follow-up tactic.",
    });
    storage.createInstinct(instinct);
    const first = manager.materializeShadowArtifact(instinct, "/projects/retry");
    manager.recordEvaluation({
      artifactIds: [first.artifact.id],
      verdict: "failure",
      blocker: true,
      reason: "Rejected once.",
      failureFingerprint: "same-blocker",
    });
    manager.recordEvaluation({
      artifactIds: [first.artifact.id],
      verdict: "failure",
      blocker: true,
      reason: "Rejected twice.",
      failureFingerprint: "same-blocker",
    });

    const second = manager.materializeShadowArtifact(instinct, "/projects/retry");
    expect(second.artifact.id).not.toBe(first.artifact.id);
    expect(second.artifact.state).toBe("shadow");
    expect(second.proposalCreated).toBe(true);
  });

  it("rejects shadow artifacts after repeated blocker-causing regressions", () => {
    const instinct = createInstinct({
      id: "instinct_reject",
      type: "correction",
      triggerPattern: "stale setup server handoff guidance",
      action: "Tell the system to refresh once and try again.",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    manager.recordEvaluation({
      artifactIds: [artifact.id],
      verdict: "failure",
      blocker: true,
      reason: "Handoff still failed.",
      failureFingerprint: "setup-handoff-timeout",
    });
    manager.recordEvaluation({
      artifactIds: [artifact.id],
      verdict: "failure",
      blocker: true,
      reason: "Handoff still failed.",
      failureFingerprint: "setup-handoff-timeout",
    });

    expect(storage.getRuntimeArtifact(artifact.id)?.state).toBe("rejected");
  });

  it("tracks recent artifact activity per identity for user-facing telemetry", () => {
    const instinct = createInstinct({
      id: "instinct_identity",
      type: "tool_usage",
      triggerPattern: "identity scoped compile fix loop",
      action: "Run read -> patch -> build loop",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    manager.recordEvaluation({
      artifactIds: [artifact.id],
      identityKey: "user-alpha",
      verdict: "clean",
      blocker: false,
      reason: "Verifier clean.",
    });

    expect(manager.getRecentArtifactsForIdentity("user-alpha", { limit: 5 })).toEqual([
      expect.objectContaining({ id: artifact.id }),
    ]);
    expect(manager.getRecentArtifactsForIdentity("user-beta", { limit: 5 })).toEqual([]);
  });

  it("retires active artifacts after sustained low clean rate", () => {
    const artifact: RuntimeArtifact = {
      id: "artifact_retire" as RuntimeArtifact["id"],
      kind: "skill",
      state: "active",
      name: "Weak Tactic",
      description: "Previously useful tactic.",
      guidance: "Try a weak tactic first.",
      taskTypes: ["debugging"],
      taskPatterns: ["debugging", "runtime", "freeze"],
      requiredToolNames: [],
      requiredCapabilities: ["reasoning"],
      sourceInstinctIds: ["instinct_retire" as any],
      sourceTrajectoryIds: [],
      stats: {
        shadowSampleCount: 5,
        activeUseCount: 5,
        cleanCount: 5,
        retryCount: 0,
        failureCount: 0,
        blockerCount: 0,
        harmfulCount: 0,
        recentEvaluations: [],
        regressionFingerprints: {},
      },
      promotedAt: Date.now() as TimestampMs,
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
    };
    storage.upsertRuntimeArtifact(artifact);

    for (let i = 0; i < 8; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        verdict: "retry",
        blocker: i % 2 === 0,
        reason: "Needed replan.",
        failureFingerprint: `retry-${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        verdict: "clean",
        blocker: false,
        reason: "Recovered.",
      });
    }

    expect(storage.getRuntimeArtifact(artifact.id)?.state).toBe("retired");
  });
});

function createInstinct(overrides: Partial<Instinct> & Pick<Instinct, "id" | "type" | "triggerPattern" | "action">): Instinct {
  return {
    id: overrides.id,
    name: overrides.name ?? `Instinct ${overrides.id}`,
    type: overrides.type,
    status: overrides.status ?? "active",
    confidence: overrides.confidence ?? 0.97,
    triggerPattern: overrides.triggerPattern,
    action: overrides.action,
    contextConditions: overrides.contextConditions ?? [],
    stats: overrides.stats ?? {
      timesSuggested: 20,
      timesApplied: 19,
      timesFailed: 1,
      successRate: 0.95,
      averageExecutionMs: 20,
    },
    createdAt: overrides.createdAt ?? Date.now() as TimestampMs,
    updatedAt: overrides.updatedAt ?? Date.now() as TimestampMs,
    sourceTrajectoryIds: overrides.sourceTrajectoryIds ?? [],
    tags: overrides.tags ?? [],
  };
}
