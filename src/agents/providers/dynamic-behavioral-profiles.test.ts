import { describe, it, expect } from "vitest";
import type { PhaseOutcome, PhaseOutcomeStatus, ExecutionPhase, TaskType } from "../../agent-core/routing/routing-types.js";
import {
  DynamicBehavioralProfileStore,
  outcomeToDimensionObservations,
  PROFILE_PRIOR_WEIGHT,
  type ProfileAccumulatorRow,
  type ProfilePersist,
} from "./dynamic-behavioral-profiles.js";
import { BehavioralDimension, getBaselineProfile } from "./provider-behavioral-profiles.js";

function outcome(overrides: Partial<PhaseOutcome> = {}): PhaseOutcome {
  return {
    provider: "claude",
    model: "claude-opus-4-8",
    role: "executor",
    phase: "executing" as ExecutionPhase,
    source: "supervisor-strategy",
    status: "approved" as PhaseOutcomeStatus,
    reason: "ok",
    task: { type: "code-generation" as TaskType, complexity: "moderate", criticality: "medium" },
    timestamp: 1000,
    ...overrides,
  };
}

describe("outcomeToDimensionObservations", () => {
  it("always emits a toolCallReliability signal", () => {
    const obs = outcomeToDimensionObservations(outcome());
    expect(obs.some((o) => o.dimension === BehavioralDimension.toolCallReliability)).toBe(true);
  });

  it("emits errorRecovery only under retry/rollback pressure", () => {
    expect(
      outcomeToDimensionObservations(outcome({ telemetry: {} }))
        .some((o) => o.dimension === BehavioralDimension.errorRecovery),
    ).toBe(false);
    expect(
      outcomeToDimensionObservations(outcome({ telemetry: { retryCount: 2 } }))
        .some((o) => o.dimension === BehavioralDimension.errorRecovery),
    ).toBe(true);
  });

  it("emits deepPlanning only for the planning phase", () => {
    expect(
      outcomeToDimensionObservations(outcome({ phase: "executing" }))
        .some((o) => o.dimension === BehavioralDimension.deepPlanning),
    ).toBe(false);
    expect(
      outcomeToDimensionObservations(outcome({ phase: "planning" }))
        .some((o) => o.dimension === BehavioralDimension.deepPlanning),
    ).toBe(true);
  });

  it("emits codeRefactoring only for code/refactoring tasks", () => {
    expect(
      outcomeToDimensionObservations(outcome({ task: { type: "conversational", complexity: "simple", criticality: "low" } }))
        .some((o) => o.dimension === BehavioralDimension.codeRefactoring),
    ).toBe(false);
    expect(
      outcomeToDimensionObservations(outcome({ task: { type: "refactoring", complexity: "moderate", criticality: "medium" } }))
        .some((o) => o.dimension === BehavioralDimension.codeRefactoring),
    ).toBe(true);
  });

  it("a replan verdict drives intentUnderstanding low in planning", () => {
    const obs = outcomeToDimensionObservations(
      outcome({ phase: "planning", status: "replanned", telemetry: { verifierDecision: "replan" } }),
    );
    const intent = obs.find((o) => o.dimension === BehavioralDimension.intentUnderstanding);
    expect(intent).toBeDefined();
    expect(intent!.value).toBeLessThan(0.4);
  });
});

describe("DynamicBehavioralProfileStore — blending", () => {
  it("with no evidence, the blended profile equals the static baseline", () => {
    const store = new DynamicBehavioralProfileStore();
    const baseline = getBaselineProfile("claude")!;
    const blended = store.getBlendedProfile("claude")!;
    expect(blended.scores[BehavioralDimension.toolCallReliability]).toBeCloseTo(
      baseline.scores[BehavioralDimension.toolCallReliability], 6,
    );
  });

  it("repeated approved outcomes pull an observed dimension above its baseline", () => {
    const store = new DynamicBehavioralProfileStore();
    const baseline = getBaselineProfile("claude")!;
    // claude's toolCallReliability baseline is 0.80; approved → observed ~0.9.
    for (let i = 0; i < 30; i++) store.ingest(outcome({ status: "approved", timestamp: 1000 + i }));
    const blended = store.getBlendedProfile("claude", "claude-opus-4-8")!;
    expect(blended.scores[BehavioralDimension.toolCallReliability]).toBeGreaterThan(
      baseline.scores[BehavioralDimension.toolCallReliability],
    );
  });

  it("repeated failures pull an observed dimension below its baseline", () => {
    const store = new DynamicBehavioralProfileStore();
    const baseline = getBaselineProfile("claude")!;
    for (let i = 0; i < 30; i++) store.ingest(outcome({ status: "failed", timestamp: 1000 + i }));
    const blended = store.getBlendedProfile("claude", "claude-opus-4-8")!;
    expect(blended.scores[BehavioralDimension.toolCallReliability]).toBeLessThan(
      baseline.scores[BehavioralDimension.toolCallReliability],
    );
  });

  it("never touches a dimension the telemetry cannot inform (stays at prior)", () => {
    const store = new DynamicBehavioralProfileStore();
    const baseline = getBaselineProfile("claude")!;
    for (let i = 0; i < 30; i++) store.ingest(outcome({ status: "failed", timestamp: 1000 + i }));
    const blended = store.getBlendedProfile("claude")!;
    // multilingualStrength is never observed → must equal the baseline exactly.
    expect(blended.scores[BehavioralDimension.multilingualStrength]).toBe(
      baseline.scores[BehavioralDimension.multilingualStrength],
    );
  });

  it("an unknown provider with no baseline yields no profile", () => {
    const store = new DynamicBehavioralProfileStore();
    expect(store.getBlendedProfile("does-not-exist")).toBeUndefined();
  });
});

describe("DynamicBehavioralProfileStore — leaderboards & pruning", () => {
  it("ranks models for a workload, best first", () => {
    const store = new DynamicBehavioralProfileStore();
    for (let i = 0; i < 20; i++) {
      store.ingest(outcome({ provider: "claude", model: "claude-opus-4-8", status: "approved", timestamp: 1000 + i }));
      store.ingest(outcome({ provider: "groq", model: "groq-fast", status: "failed", timestamp: 1000 + i }));
    }
    const ranked = store.rankModelsForWorkload("implementation");
    expect(ranked.length).toBeGreaterThan(0);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it("prunes de-supported models via the live-models map", () => {
    const store = new DynamicBehavioralProfileStore();
    for (let i = 0; i < 10; i++) {
      store.ingest(outcome({ provider: "claude", model: "claude-opus-4-8", timestamp: 1000 + i }));
      store.ingest(outcome({ provider: "claude", model: "claude-retired-model", timestamp: 1000 + i }));
    }
    const live = new Map<string, ReadonlySet<string>>([["claude", new Set(["claude-opus-4-8"])]]);
    const ranked = store.rankModelsForWorkload("implementation", live);
    const models = ranked.filter((r) => r.model).map((r) => r.model);
    expect(models).toContain("claude-opus-4-8");
    expect(models).not.toContain("claude-retired-model");
  });

  it("does NOT prune when a provider's live set is empty (discovery failure ≠ de-supported)", () => {
    const store = new DynamicBehavioralProfileStore();
    for (let i = 0; i < 10; i++) {
      store.ingest(outcome({ provider: "claude", model: "claude-opus-4-8", timestamp: 1000 + i }));
    }
    // An empty set models "couldn't determine live models" (e.g. a timeout) —
    // the rows must be KEPT, not blanked.
    const live = new Map<string, ReadonlySet<string>>([["claude", new Set<string>()]]);
    const models = store.rankModelsForWorkload("implementation", live)
      .filter((r) => r.model).map((r) => r.model);
    expect(models).toContain("claude-opus-4-8");
  });

  it("drift is positive when a model beats its baseline", () => {
    const store = new DynamicBehavioralProfileStore();
    for (let i = 0; i < 30; i++) {
      store.ingest(outcome({ provider: "groq", model: "groq-fast", status: "approved", timestamp: 1000 + i, task: { type: "code-generation", complexity: "moderate", criticality: "medium" } }));
    }
    const ranked = store.rankModelsForWorkload("implementation");
    const groqModel = ranked.find((r) => r.model === "groq-fast");
    expect(groqModel).toBeDefined();
    expect(groqModel!.drift).toBeGreaterThan(0);
  });
});

describe("DynamicBehavioralProfileStore — confidence & snapshots", () => {
  it("confidence rises with more observations", () => {
    const store = new DynamicBehavioralProfileStore();
    store.ingest(outcome({ timestamp: 1000 }));
    const low = store.getSnapshot("claude", "claude-opus-4-8")!.confidence[BehavioralDimension.toolCallReliability] ?? 0;
    for (let i = 0; i < 20; i++) store.ingest(outcome({ timestamp: 1001 + i }));
    const high = store.getSnapshot("claude", "claude-opus-4-8")!.confidence[BehavioralDimension.toolCallReliability] ?? 0;
    expect(high).toBeGreaterThan(low);
  });

  it("getAllSnapshots covers both provider- and model-level keys", () => {
    const store = new DynamicBehavioralProfileStore();
    store.ingest(outcome({ timestamp: 1000 }));
    const keys = store.getAllSnapshots().map((s) => s.key);
    expect(keys).toContain("claude");
    expect(keys).toContain("claude::claude-opus-4-8");
  });

  it("ignores malformed outcomes without a provider", () => {
    const store = new DynamicBehavioralProfileStore();
    store.ingest({ ...outcome(), provider: "" });
    expect(store.getAllSnapshots()).toHaveLength(0);
  });
});

describe("DynamicBehavioralProfileStore — persistence", () => {
  it("round-trips accumulators through the persistence boundary", async () => {
    const rows: ProfileAccumulatorRow[] = [];
    const persist: ProfilePersist = {
      load: () => rows,
      save: (next) => { rows.length = 0; rows.push(...next); },
    };
    const store = new DynamicBehavioralProfileStore(persist);
    for (let i = 0; i < 15; i++) store.ingest(outcome({ status: "approved", timestamp: 1000 + i }));
    await store.flush();
    expect(rows.length).toBeGreaterThan(0);

    const restored = new DynamicBehavioralProfileStore(persist);
    await restored.initialize();
    const a = store.getBlendedProfile("claude", "claude-opus-4-8")!;
    const b = restored.getBlendedProfile("claude", "claude-opus-4-8")!;
    expect(b.scores[BehavioralDimension.toolCallReliability]).toBeCloseTo(
      a.scores[BehavioralDimension.toolCallReliability], 6,
    );
  });

  it("prior weight is the documented constant", () => {
    expect(PROFILE_PRIOR_WEIGHT).toBe(4);
  });

  // audited 2026-09-02: initialize() rebuilt stats and lastSeen but never counts, and the
  // row had no count field to carry it — so after a restart every snapshot / ranking
  // reported observationCount 0 next to a score that was ~88% observation-driven and a
  // real prior-run updatedAt. The count is evidence; it has to survive with the score.
  it("restores observationCount after a restart, alongside the scores it explains", async () => {
    const rows: ProfileAccumulatorRow[] = [];
    const persist: ProfilePersist = {
      load: () => rows,
      save: (next) => { rows.length = 0; rows.push(...next); },
    };
    const store = new DynamicBehavioralProfileStore(persist);
    for (let i = 0; i < 40; i++) store.ingest(outcome({ status: "approved", timestamp: 1000 + i }));
    await store.flush();
    const before = store.getSnapshot("claude", "claude-opus-4-8")!;
    expect(before.observationCount).toBe(40);

    const restored = new DynamicBehavioralProfileStore(persist);
    await restored.initialize();
    const after = restored.getSnapshot("claude", "claude-opus-4-8")!;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.observationCount).toBe(40);
    const ranked = restored.rankModelsForWorkload("implementation").find((r) => r.model === "claude-opus-4-8")!;
    expect(ranked.observationCount).toBe(40);
  });

  it("rows written before the count existed still load (count reads as 0, not NaN)", async () => {
    const legacy: ProfileAccumulatorRow[] = [
      { key: "claude::claude-opus-4-8", dimension: "toolCallReliability", ema: 0.9, samples: 5, updatedAt: 1 },
    ];
    const store = new DynamicBehavioralProfileStore({ load: () => legacy, save: () => {} });
    await store.initialize();
    expect(store.getSnapshot("claude", "claude-opus-4-8")!.observationCount).toBe(0);
  });
});
