/**
 * ROUND 11 #1 — A PRIVATE RULE REACHES ITS OWNER AND NOBODY ELSE, THROUGH EVERY
 * CARRIER.
 *
 * Round 10 #3 closed instinct retrieval: a `scope_type='user'` instinct is a
 * candidate only for the identity that owns it. It did not close the OTHER
 * carrier. A private instinct that earns its five clean exposures becomes a
 * runtime artifact, and the artifact row carried the project scope and the
 * source instinct ids but NO OWNER — while `matchForTask` accepted no identity
 * at all. So Alice's private correction was excluded from Bob's instinct
 * retrieval and then handed to him in the same prompt as "runtime
 * self-improvement" guidance.
 *
 * The guard direction matters as much: project/global guidance must keep
 * reaching everybody (including an unidentified caller), and Alice must keep
 * seeing her own — closing the leak by hiding every artifact would take the
 * whole mechanism dark.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearningStorage } from "./storage/learning-storage.js";
import { RuntimeArtifactManager, createProjectScopeFingerprint } from "./runtime-artifact-manager.js";
import type { Instinct, InstinctId, RuntimeArtifact } from "./types.js";
import type { TimestampMs } from "../types/index.js";

const PROJECT = "/projects/pixelflow";
const SCOPE = createProjectScopeFingerprint(PROJECT);

const TASK = {
  taskDescription: "Fix the pooling compile error and rerun the build",
  taskType: "debugging" as const,
  projectWorldFingerprint: SCOPE,
  availableToolNames: [] as readonly string[],
};

function makeInstinct(over: Partial<Instinct> & { id: string }): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: over.id as InstinctId,
    name: over.name ?? "pooling compile rule",
    type: over.type ?? "tool_usage",
    status: over.status ?? "active",
    confidence: over.confidence ?? 0.95,
    triggerPattern: over.triggerPattern ?? "pooling compile error in the build",
    action: over.action ?? "Read the compile output, inspect the pooling files, rerun the build",
    contextConditions: over.contextConditions ?? [],
    stats: { timesSuggested: 9, timesApplied: 9, timesFailed: 0, successRate: 1, averageExecutionMs: 10 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
}

describe("a private rule reaches its owner and nobody else, through the artifact too (r11 #1)", () => {
  let storage: LearningStorage;
  let manager: RuntimeArtifactManager;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
    manager = new RuntimeArtifactManager(storage);
  });

  afterEach(() => {
    storage.close();
  });

  /** Materialize the artifact for `instinct` and take it through to `active`. */
  function promote(instinct: Instinct): RuntimeArtifact {
    const { artifact } = manager.materializeShadowArtifact(instinct, PROJECT);
    for (let i = 0; i < 5; i++) {
      manager.recordEvaluation({
        artifactIds: [artifact.id],
        presentedInstinctIds: [String(instinct.id)],
        verdict: "clean",
        blocker: false,
        reason: "Verifier clean with the guidance in the prompt.",
      });
    }
    const promoted = storage.getRuntimeArtifact(artifact.id);
    expect(promoted?.state, "fixture did not reach 'active'").toBe("active");
    return promoted!;
  }

  function guidanceIdsFor(userId: string | undefined): string[] {
    const matches = manager.matchForTask({ ...TASK, ...(userId ? { userId } : {}) });
    return [...matches.active, ...matches.shadow].map((m) => String(m.artifact.id));
  }

  it("PROOF: Alice's promoted private rule is not handed to Bob or to an unidentified caller", () => {
    const alices = makeInstinct({ id: "instinct_alice_private", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const artifact = promote(alices);

    // Instinct retrieval already excludes it (round 10 #3) — the control.
    expect(
      storage.getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "all", userId: "bob" }).map((i) => String(i.id)),
    ).not.toContain(String(alices.id));

    // TEETH: before the fix the artifact row had no owner and matchForTask took
    // no identity, so this list contained the artifact for BOTH of them.
    expect(guidanceIdsFor("bob"), "Alice's private rule reached Bob through the artifact").not.toContain(
      String(artifact.id),
    );
    expect(
      guidanceIdsFor(undefined),
      "Alice's private rule reached an unidentified caller through the artifact",
    ).not.toContain(String(artifact.id));
  });

  it("GUARD: the owner still gets her own guidance, as usable execution guidance", () => {
    const alices = makeInstinct({ id: "instinct_alice_guard", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const artifact = promote(alices);

    const mine = manager.matchForTask({ ...TASK, userId: "alice" });
    expect(mine.active.map((m) => String(m.artifact.id))).toContain(String(artifact.id));
    expect(mine.active[0]?.usableForExecutionGuidance).toBe(true);
  });

  it("GUARD: shared project learning stays reachable for everybody, identified or not", () => {
    const shared = makeInstinct({ id: "instinct_project_rule", scopeType: "project" });
    storage.createInstinct(shared, PROJECT);
    const artifact = promote(shared);

    for (const userId of ["alice", "bob", undefined]) {
      expect(guidanceIdsFor(userId), `shared artifact went dark for ${userId ?? "an unidentified caller"}`).toContain(
        String(artifact.id),
      );
    }
  });

  it("a legacy artifact row whose ownership cannot be established is quarantined, not broadcast", () => {
    // What is actually on disk today: a row written before the owner column
    // existed, whose source instinct is gone, so nothing can say whose it was.
    const legacy: RuntimeArtifact = {
      id: "artifact_legacy" as RuntimeArtifact["id"],
      kind: "workflow",
      state: "active",
      name: "Legacy Pooling Flow",
      description: "Use compile errors to drive the pooling fix loop.",
      guidance: "Read compiler output, inspect failing pooling files, rerun the build.",
      taskTypes: ["debugging"],
      taskPatterns: ["pooling", "compile", "build"],
      projectWorldFingerprint: SCOPE,
      requiredToolNames: [],
      requiredCapabilities: ["tool-calling"],
      sourceInstinctIds: ["instinct_long_gone" as InstinctId],
      sourceTrajectoryIds: [],
      stats: {
        shadowSampleCount: 5,
        exposureCount: 5,
        exposedCleanCount: 5,
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
    storage.upsertRuntimeArtifact(legacy);
    // Simulate the pre-migration row: no ownership recorded at all.
    storage.debugClearRuntimeArtifactOwnership(String(legacy.id));

    const swept = storage.quarantineUnownedRuntimeArtifacts();
    expect(swept.quarantined).toBe(1);

    for (const userId of ["alice", "bob", undefined]) {
      expect(guidanceIdsFor(userId), `an unownable legacy artifact reached ${userId ?? "an unidentified caller"}`)
        .not.toContain(String(legacy.id));
    }
    // Quarantined, not deleted: still there to be audited or re-owned.
    expect(storage.getRuntimeArtifact(legacy.id)).not.toBeNull();
  });

  it("a legacy artifact whose single private source is still on disk is adopted, not quarantined", () => {
    const alices = makeInstinct({ id: "instinct_alice_recoverable", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const artifact = promote(alices);
    storage.debugClearRuntimeArtifactOwnership(String(artifact.id));

    const swept = storage.quarantineUnownedRuntimeArtifacts();
    expect(swept.ownerRecovered).toBe(1);
    expect(swept.quarantined).toBe(0);

    expect(guidanceIdsFor("alice")).toContain(String(artifact.id));
    expect(guidanceIdsFor("bob")).not.toContain(String(artifact.id));
  });

  it("ownership survives promotion: the artifact is still Alice's after it goes active", () => {
    const alices = makeInstinct({ id: "instinct_alice_promotion", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const artifact = promote(alices);
    expect(artifact.ownerScope).toBe("user");
    expect(artifact.ownerUserId).toBe("alice");
  });

  it("the per-identity activity list does not show one person's private artifact to another", () => {
    const alices = makeInstinct({ id: "instinct_alice_activity", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const { artifact } = manager.materializeShadowArtifact(alices, PROJECT);

    // The chat, not the person, is the identity key when no user id is known —
    // which is how a private artifact showed up in a shared chat's activity.
    manager.recordEvaluation({
      artifactIds: [artifact.id],
      presentedInstinctIds: [String(alices.id)],
      identityKey: "chat-shared",
      verdict: "clean",
      blocker: false,
      reason: "clean",
    });
    manager.recordEvaluation({
      artifactIds: [artifact.id],
      presentedInstinctIds: [String(alices.id)],
      identityKey: "alice",
      verdict: "clean",
      blocker: false,
      reason: "clean",
    });

    expect(manager.getRecentArtifactsForIdentity("chat-shared").map((a) => String(a.id))).not.toContain(
      String(artifact.id),
    );
    expect(manager.getRecentArtifactsForIdentity("alice").map((a) => String(a.id))).toContain(String(artifact.id));
  });

  it("an artifact of unknown ownership is listed for nobody, and shown to nobody", () => {
    // A private instinct whose owner was never recorded (the round 10 #3 shape)
    // cannot produce a reachable artifact: it may be anybody's rule.
    const ownerless = makeInstinct({ id: "instinct_ownerless_private", scopeType: "user" });
    storage.createInstinct(ownerless, PROJECT);
    const { artifact } = manager.materializeShadowArtifact(ownerless, PROJECT);
    expect(artifact.ownerScope).toBe("unknown");

    manager.recordEvaluation({
      artifactIds: [artifact.id],
      presentedInstinctIds: [String(ownerless.id)],
      identityKey: "alice",
      verdict: "clean",
      blocker: false,
      reason: "clean",
    });

    // Both carriers: the activity list AND the prompt-matching path.
    expect(manager.getRecentArtifactsForIdentity("alice").map((a) => String(a.id))).not.toContain(String(artifact.id));
    for (const userId of ["alice", "bob", undefined]) {
      expect(guidanceIdsFor(userId), `an unownable artifact reached ${userId ?? "an unidentified caller"}`)
        .not.toContain(String(artifact.id));
    }
  });

  it("GUARD: a public artifact is listed for a chat-scoped identity key too", () => {
    const shared = makeInstinct({ id: "instinct_public_activity", scopeType: "project" });
    storage.createInstinct(shared, PROJECT);
    const { artifact } = manager.materializeShadowArtifact(shared, PROJECT);

    manager.recordEvaluation({
      artifactIds: [artifact.id],
      presentedInstinctIds: [String(shared.id)],
      identityKey: "chat-shared",
      verdict: "clean",
      blocker: false,
      reason: "clean",
    });

    expect(manager.getRecentArtifactsForIdentity("chat-shared").map((a) => String(a.id))).toContain(String(artifact.id));
  });
});
