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
        // The guidance was actually presented in each of these runs.
        exposedArtifactIds: [artifact.id],
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
        exposedArtifactIds: [artifact.id],
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

  it("starts a fresh shadow artifact after a rejection, once its rule has new evidence, instead of reusing terminal state", () => {
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

    const withNewEvidence = { ...instinct, stats: { ...instinct.stats, timesApplied: instinct.stats.timesApplied + 1 } };
    const second = manager.materializeShadowArtifact(withNewEvidence, "/projects/retry");
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

  it("evicts least-recently-used identities beyond the cap (M12)", () => {
    const instinct = createInstinct({
      id: "instinct_m12",
      type: "tool_usage",
      triggerPattern: "m12 identity cap loop",
      action: "Run read -> patch -> build loop",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    // 257 distinct identities = MAX_TRACKED_IDENTITIES (256) + 1. identity-0 is
    // touched first and never again, so it is the LRU once the cap is exceeded.
    for (let i = 0; i < 257; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        identityKey: `identity-${i}`,
        verdict: "clean",
        blocker: false,
        reason: "Verifier clean.",
      });
    }

    // TEETH: without the LRU bound the map keeps every identity, so identity-0
    // still has history and this returns [objectContaining(...)] instead of [].
    expect(manager.getRecentArtifactsForIdentity("identity-0", { limit: 5 })).toEqual([]);
    expect(manager.getRecentArtifactsForIdentity("identity-256", { limit: 5 })).toEqual([
      expect.objectContaining({ id: artifact.id }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // D41 (audit 04.3a/b): promotion needs EXPOSURE, not coincidence.
  // ---------------------------------------------------------------------------

  it("does not promote a shadow artifact nobody was ever shown (D41)", () => {
    const instinct = createInstinct({
      id: "instinct_unexposed",
      type: "tool_usage",
      triggerPattern: "guidance that never reached a prompt",
      action: "Run read -> patch -> build loop",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    // Five clean runs that merely MATCHED the artifact: shadow artifacts are
    // never rendered into a prompt, so nothing in these runs saw the guidance.
    for (let i = 0; i < 5; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        verdict: "clean",
        blocker: false,
        reason: "Verifier clean, but the artifact was not presented.",
      });
    }

    // TEETH: the unfixed scorer counted every match as a shadow sample and
    // promoted unseen guidance after five clean runs.
    const observed = storage.getRuntimeArtifact(artifact.id);
    expect(observed?.state).toBe("shadow");
    expect(observed?.stats.shadowSampleCount).toBe(5);
    expect(observed?.stats.exposureCount ?? 0).toBe(0);
  });

  it("counts an exposure when the run was shown the source instinct (D41 guard)", () => {
    const instinct = createInstinct({
      id: "instinct_presented",
      type: "tool_usage",
      triggerPattern: "guidance carried by its instinct",
      action: "Run read -> patch -> build loop",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    for (let i = 0; i < 5; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        presentedInstinctIds: [instinct.id],
        verdict: "clean",
        blocker: false,
        reason: "Verifier clean with the instinct in the prompt.",
      });
    }

    expect(storage.getRuntimeArtifact(artifact.id)?.state).toBe("active");
  });

  it("does not promote on exposed runs that were not clean", () => {
    const instinct = createInstinct({
      id: "instinct_exposed_dirty",
      type: "tool_usage",
      triggerPattern: "exposed but retried",
      action: "Run read -> patch -> build loop",
    });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);

    for (let i = 0; i < 6; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        exposedArtifactIds: [artifact.id],
        verdict: i < 3 ? "clean" : "retry",
        blocker: false,
        reason: "Mixed outcomes.",
        failureFingerprint: `retry-${i}`,
      });
    }

    expect(storage.getRuntimeArtifact(artifact.id)?.state).toBe("shadow");
  });

  it("does not hand out execution guidance on a task-type coincidence alone (D41)", () => {
    const artifact: RuntimeArtifact = {
      id: "artifact_coincidence" as RuntimeArtifact["id"],
      kind: "skill",
      state: "active",
      name: "Shader Cache Tactic",
      description: "Clear the shader cache before rebuilding lightmaps.",
      guidance: "Clear the shader cache before rebuilding lightmaps.",
      taskTypes: ["debugging"],
      taskPatterns: ["shader", "cache", "lightmap"],
      // No tools required and no project scope: task type is the only signal.
      requiredToolNames: [],
      requiredCapabilities: ["reasoning"],
      sourceInstinctIds: ["instinct_coincidence" as any],
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

    const matches = manager.matchForTask({
      taskDescription: "Investigate why the payroll export drops the final column",
      taskType: "debugging",
      availableToolNames: [],
    });

    // TEETH: the unfixed score was 0.45 (task type) + 0.15 (an EMPTY tool list
    // scored as full coverage) = 0.60 >= 0.55, so unrelated guidance was
    // presented as execution guidance.
    expect(matches.active[0]?.usableForExecutionGuidance ?? false).toBe(false);
  });

  it("refuses a scoped artifact in a different project outright (D41)", () => {
    const artifact: RuntimeArtifact = {
      id: "artifact_otherworld" as RuntimeArtifact["id"],
      kind: "workflow",
      state: "active",
      name: "Pooling Compile Flow",
      description: "Use compile errors to drive the pooling fix loop.",
      guidance: "Read compiler output, inspect failing pooling files, rerun the build.",
      taskTypes: ["debugging"],
      taskPatterns: ["pooling", "compile", "build"],
      projectWorldFingerprint: "root projects alpha",
      requiredToolNames: [],
      requiredCapabilities: ["tool-calling"],
      sourceInstinctIds: ["instinct_otherworld" as any],
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

    // Same words, different project: a known scope mismatch is a gate, not a
    // missing 0.15 bonus.
    const mismatch = manager.matchForTask({
      taskDescription: "Fix the pooling compile error and rerun the build",
      taskType: "debugging",
      projectWorldFingerprint: "root projects beta",
      availableToolNames: [],
    });
    expect(mismatch.active).toHaveLength(0);
    expect(mismatch.shadow).toHaveLength(0);

    // GUARD: the same artifact in its own project is still usable guidance.
    const inScope = manager.matchForTask({
      taskDescription: "Fix the pooling compile error and rerun the build",
      taskType: "debugging",
      projectWorldFingerprint: "root projects alpha",
      availableToolNames: [],
    });
    expect(inScope.active).toHaveLength(1);
    expect(inScope.active[0]?.usableForExecutionGuidance).toBe(true);
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

// LRN-15: a rejected or retired artifact came back as a fresh shadow on the
// next evolution tick while its rule was still eligible, with no new evidence.
describe("a closed runtime artifact returns only on new evidence (LRN-15)", () => {
  let tempDir: string;
  let storage: LearningStorage;
  let manager: RuntimeArtifactManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "runtime-artifacts-closed-"));
    storage = new LearningStorage(join(tempDir, "learning.db"));
    storage.initialize();
    manager = new RuntimeArtifactManager(storage);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function rejectedArtifactFor(instinct: Instinct) {
    storage.createInstinct(instinct);
    const first = manager.materializeShadowArtifact(instinct);
    for (let i = 0; i < 3; i++) {
      manager.recordEvaluation({ artifactIds: [first.artifact.id], verdict: "failure", blocker: false, reason: "Harmful." });
    }
    expect(storage.getRuntimeArtifact(first.artifact.id)?.state).toBe("rejected");
    return first.artifact;
  }

  function withOneMoreApplication(instinct: Instinct): Instinct {
    const next = { ...instinct, stats: { ...instinct.stats, timesApplied: instinct.stats.timesApplied + 1 } };
    storage.updateInstinct(next);
    return next;
  }

  const artifactsFor = (id: string) => storage.getRuntimeArtifactsBySourceInstinct(id);

  it("a rejected artifact records its rule's evidence and is not re-materialized without more", () => {
    const instinct = createInstinct({ id: "instinct_harmful", type: "correction", triggerPattern: "harmful tactic", action: "Do the harmful thing." });
    const rejected = rejectedArtifactFor(instinct);
    expect(storage.getRuntimeArtifact(rejected.id)?.sourceEvidenceAtClose).toEqual({ instinct_harmful: 20 });

    // Later ticks: same rule, same evidence, even though it was touched since.
    const again = manager.materializeShadowArtifact({ ...instinct, updatedAt: (Date.now() + 60_000) as TimestampMs });
    expect(again).toMatchObject({ created: false, proposalCreated: false });
    expect(artifactsFor(instinct.id).map((a) => a.state)).toEqual(["rejected"]);
    expect(storage.getEvolutionProposals({ instinctId: instinct.id })).toHaveLength(1);

    // New evidence for the rule: it may be evaluated again, from a fresh shadow.
    const fresh = manager.materializeShadowArtifact(withOneMoreApplication(instinct));
    expect(fresh).toMatchObject({ created: true, proposalCreated: true });
    expect(fresh.artifact.id).not.toBe(rejected.id);
    expect(fresh.artifact.state).toBe("shadow");
  });

  it("a retired artifact is not re-materialized without new evidence either", () => {
    const instinct = createInstinct({ id: "instinct_worn", type: "correction", triggerPattern: "worn out tactic", action: "Use the worn out tactic." });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);
    storage.upsertRuntimeArtifact({ ...storage.getRuntimeArtifact(artifact.id)!, state: "active" });
    for (let i = 0; i < 4; i++) {
      manager.recordEvaluation({ artifactIds: [artifact.id], verdict: "retry", blocker: true, reason: "Needed replan." });
    }
    expect(storage.getRuntimeArtifact(artifact.id)?.state).toBe("retired");

    expect(manager.materializeShadowArtifact(instinct).created).toBe(false);
    expect(artifactsFor(instinct.id)).toHaveLength(1);
  });

  it("a closure recorded before the count existed takes today's count as its baseline", () => {
    const instinct = createInstinct({ id: "instinct_legacy", type: "correction", triggerPattern: "legacy tactic", action: "Use the legacy tactic." });
    const rejected = rejectedArtifactFor(instinct);
    const legacy = { ...storage.getRuntimeArtifact(rejected.id)! };
    delete (legacy as { sourceEvidenceAtClose?: unknown }).sourceEvidenceAtClose;
    storage.upsertRuntimeArtifact(legacy);

    expect(manager.materializeShadowArtifact(instinct).created).toBe(false);
    expect(storage.getRuntimeArtifact(rejected.id)?.sourceEvidenceAtClose).toEqual({ instinct_legacy: 20 });
    expect(manager.materializeShadowArtifact(withOneMoreApplication(instinct)).created).toBe(true);
  });

  it("retiring the rule records the evidence on the artifacts it retires", () => {
    const instinct = createInstinct({ id: "instinct_manual", type: "correction", triggerPattern: "manual tactic", action: "Use the manual tactic." });
    storage.createInstinct(instinct);
    const { artifact } = manager.materializeShadowArtifact(instinct);
    storage.retireInstinct(instinct.id, { reason: "wrong", actor: "test" });
    expect(storage.getRuntimeArtifact(artifact.id)).toMatchObject({
      state: "retired",
      sourceEvidenceAtClose: { instinct_manual: 20 },
    });
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
