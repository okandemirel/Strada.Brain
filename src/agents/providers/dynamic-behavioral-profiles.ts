/**
 * Provider Behavioral Intelligence — Tier 2 (Dynamic Learning Layer)
 *
 * The companion to `provider-behavioral-profiles.ts` (Tier 1, the static
 * research-backed baselines). That module's header promises a "dynamic learning
 * system (Tier 2) [that] adjusts [the baselines] over time based on observed
 * runtime performance." This is that system.
 *
 * What it does
 * ------------
 * Every routed phase produces a `PhaseOutcome` (provider, model, task, status,
 * verifier/verdict telemetry). This store translates those outcomes into
 * per-behavioral-dimension *observations*, accumulates them with a forgetting
 * EMA (so it tracks current performance, not ancient history), and blends them
 * against the static baseline with a Bayesian prior:
 *
 *     blended = (PRIOR_WEIGHT · static + effectiveSamples · observed)
 *               ───────────────────────────────────────────────────
 *                          PRIOR_WEIGHT + effectiveSamples
 *
 * With no evidence a dimension stays at its curated baseline; as real outcomes
 * accumulate, observation takes over. Dimensions the telemetry cannot honestly
 * inform (e.g. multilingualStrength) are never touched — they stay at prior.
 *
 * Granularity: accumulates at BOTH provider level (`claude`) and model level
 * (`claude::claude-opus-4-8`). A model inherits its provider's static baseline
 * as its prior, then specialises as its own outcomes arrive.
 *
 * The blended profiles are `BehavioralProfile`-shaped, so they drop straight
 * into `deriveWorkloadScores` / `rankProvidersForWorkload` — routing and the
 * task-grouped leaderboards become telemetry-driven with no scoring-math change.
 *
 * Pure of side effects except through an injected {@link ProfilePersist}
 * boundary (so persistence is optional and fully testable). Never throws into
 * the hot path: a bad outcome is ignored, a failed persist is swallowed.
 */

import type { PhaseOutcome } from "../../agent-core/routing/routing-types.js";
import {
  BehavioralDimension,
  getBaselineProfile,
  type BehavioralProfile,
  type WorkloadType,
  WORKLOAD_DIMENSION_WEIGHTS,
} from "./provider-behavioral-profiles.js";

// ---------------------------------------------------------------------------
// Tuning constants (named, not magic — mirrors provider-router's prior pattern)
// ---------------------------------------------------------------------------

/** Bayesian prior strength: how many observations it takes for evidence to
 *  equal the static baseline. Matches provider-router's PHASE_SCORE_PRIOR_WEIGHT. */
export const PROFILE_PRIOR_WEIGHT = 4;

/** Saturation cap on effective sample count per dimension. Keeps the EMA
 *  perpetually adaptive (alpha never decays to zero) so the system keeps
 *  tracking *current* behaviour instead of freezing on old data. */
export const MAX_EFFECTIVE_SAMPLES = 30;

/** Neutral score used when a baseline profile is missing for a provider. */
const NEUTRAL_SCORE = 0.5;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Outcome → dimension observations
// ---------------------------------------------------------------------------

/** A single observation of one behavioral dimension, in [0,1] with a confidence weight. */
export interface DimensionObservation {
  readonly dimension: BehavioralDimension;
  /** Observed quality for this dimension, normalized to 0..1. */
  readonly value: number;
  /** Confidence weight of this observation (higher = stronger evidence). */
  readonly weight: number;
}

/** Base quality implied by a phase status, on a 0..1 scale. */
function statusQuality(status: PhaseOutcome["status"]): number {
  switch (status) {
    case "approved": return 1;
    case "continued": return 0.65;
    case "replanned": return 0.3;
    case "blocked": return 0.12;
    case "failed": return 0;
    default: return NEUTRAL_SCORE;
  }
}

/**
 * Translate a PhaseOutcome into per-dimension observations. Only dimensions the
 * telemetry *genuinely* informs are emitted; the rest are left to the prior.
 * This is deliberately conservative — fabricating signal for an unobservable
 * dimension (e.g. multilingualStrength) would corrupt the baseline.
 *
 * Exported for unit testing.
 */
export function outcomeToDimensionObservations(outcome: PhaseOutcome): DimensionObservation[] {
  const obs: DimensionObservation[] = [];
  const base = statusQuality(outcome.status);
  const t = outcome.telemetry;
  const phase = outcome.phase;
  const taskType = outcome.task?.type;
  const critical = outcome.task?.criticality === "high" || outcome.task?.criticality === "critical";
  // Critical-task outcomes are stronger evidence than trivial ones.
  const baseWeight = critical ? 1.3 : 1;

  // toolCallReliability — verifier acceptance + non-failure is the cleanest
  // signal of well-formed, correctly-sequenced tool use.
  {
    let v = base;
    if (t?.verifierDecision === "approve") v = Math.max(v, 0.9);
    else if (t?.verifierDecision === "replan") v = Math.min(v, 0.3);
    obs.push({ dimension: BehavioralDimension.toolCallReliability, value: clamp01(v), weight: baseWeight });
  }

  // errorRecovery — did it recover after pressure (retries/rollbacks)?
  // Recovering to a good status despite retries is strong positive evidence;
  // failing after retries is strong negative evidence. No pressure → no signal.
  {
    const retries = t?.retryCount ?? 0;
    const rollbacks = t?.rollbackDepth ?? 0;
    const pressure = retries + rollbacks;
    if (pressure > 0) {
      obs.push({
        dimension: BehavioralDimension.errorRecovery,
        value: clamp01(base),
        // More pressure that was (or wasn't) overcome = more informative.
        weight: baseWeight * Math.min(1 + pressure * 0.25, 2),
      });
    }
  }

  // Verdict score (0..1) is a graded quality judgement — feed it to the
  // reasoning-ish dimensions, gated by the phase/task it came from.
  const verdict = typeof t?.phaseVerdictScore === "number" ? clamp01(t.phaseVerdictScore) : undefined;

  // complexReasoning — review/analysis/replanning phases and analytical tasks.
  if (phase === "planning" || phase === "replanning" || phase === "synthesis" ||
      phase.endsWith("-review") || taskType === "analysis" || taskType === "debugging") {
    obs.push({
      dimension: BehavioralDimension.complexReasoning,
      value: verdict ?? clamp01(base),
      weight: baseWeight,
    });
  }

  // deepPlanning — only the planning phase informs planning depth.
  if (phase === "planning" || taskType === "planning") {
    obs.push({
      dimension: BehavioralDimension.deepPlanning,
      value: verdict ?? clamp01(base),
      weight: baseWeight,
    });
  }

  // intentUnderstanding — a replan (especially in planning/clarification)
  // signals the intent was missed; an approve signals it was understood.
  if (phase === "planning" || phase === "clarification-review") {
    let v = base;
    if (t?.verifierDecision === "replan") v = Math.min(v, 0.25);
    else if (t?.verifierDecision === "approve") v = Math.max(v, 0.85);
    obs.push({ dimension: BehavioralDimension.intentUnderstanding, value: clamp01(v), weight: baseWeight });
  }

  // codeRefactoring — implementation/refactoring tasks during execution.
  if (taskType === "code-generation" || taskType === "refactoring") {
    obs.push({
      dimension: BehavioralDimension.codeRefactoring,
      value: verdict ?? clamp01(base),
      weight: baseWeight,
    });
  }

  return obs;
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

/** Forgetting running estimate for one dimension. */
interface DimensionStat {
  /** Current EMA estimate of the dimension, 0..1. */
  ema: number;
  /** Effective sample count (saturates at MAX_EFFECTIVE_SAMPLES). */
  samples: number;
}

/** Serializable row for persistence: one (key, dimension) accumulator. */
export interface ProfileAccumulatorRow {
  /** Accumulator key: `provider` or `provider::model`. */
  readonly key: string;
  readonly dimension: string;
  readonly ema: number;
  readonly samples: number;
  readonly updatedAt: number;
  /**
   * Total outcomes folded into this row's KEY (repeated on every dimension row
   * of the key). Optional so rows written before it existed still load.
   * audited 2026-09-02: without it every restart reported observationCount 0
   * beside scores that were ~88% observation-driven.
   */
  readonly observations?: number;
}

/** Injected persistence boundary (mirrors model-intelligence's CatalogPersist). */
export interface ProfilePersist {
  load(): ProfileAccumulatorRow[] | Promise<ProfileAccumulatorRow[]>;
  save(rows: ProfileAccumulatorRow[]): void | Promise<void>;
}

/** Public, per-key snapshot for the dashboard / API. */
export interface DynamicProfileSnapshot {
  /** `provider` or `provider::model`. */
  readonly key: string;
  readonly provider: string;
  /** Model id, or undefined for a provider-level aggregate. */
  readonly model?: string;
  /** The blended (prior + evidence) dimension scores, 0..1. */
  readonly scores: Readonly<Record<BehavioralDimension, number>>;
  /** Per-dimension blend confidence (0 = pure prior … 1 = fully observed). */
  readonly confidence: Readonly<Partial<Record<BehavioralDimension, number>>>;
  /** Total observed outcomes folded into this key. */
  readonly observationCount: number;
  /** Most recent outcome timestamp folded in, or 0. */
  readonly updatedAt: number;
}

/** One entry in a per-workload model leaderboard. */
export interface ModelWorkloadRanking {
  readonly provider: string;
  readonly model?: string;
  readonly key: string;
  /** Composite workload score from the blended profile, 0..1. */
  readonly score: number;
  /** Blend confidence for this workload's weighted dimensions, 0..1. */
  readonly confidence: number;
  /** Drift from the static baseline (blended − prior); + = beating baseline. */
  readonly drift: number;
  readonly observationCount: number;
}

const KEY_SEP = "::";

function makeKey(provider: string, model?: string): string {
  const p = provider.toLowerCase().trim();
  return model ? `${p}${KEY_SEP}${model.trim()}` : p;
}

function splitKey(key: string): { provider: string; model?: string } {
  const idx = key.indexOf(KEY_SEP);
  if (idx === -1) return { provider: key };
  return { provider: key.slice(0, idx), model: key.slice(idx + KEY_SEP.length) };
}

const ALL_DIMENSIONS = Object.values(BehavioralDimension);

/**
 * Tier 2 dynamic behavioral profile store. Construct once, feed it every
 * PhaseOutcome, read blended profiles / leaderboards from it.
 */
export class DynamicBehavioralProfileStore {
  /** key → (dimension → stat). */
  private readonly stats = new Map<string, Map<BehavioralDimension, DimensionStat>>();
  /** key → total observations folded in. */
  private readonly counts = new Map<string, number>();
  /** key → latest outcome timestamp. */
  private readonly lastSeen = new Map<string, number>();
  private dirty = false;

  constructor(
    private readonly persist?: ProfilePersist,
    private readonly priorWeight: number = PROFILE_PRIOR_WEIGHT,
    private readonly maxSamples: number = MAX_EFFECTIVE_SAMPLES,
  ) {}

  /** Load persisted accumulators (call once at boot). Never throws. */
  async initialize(): Promise<void> {
    if (!this.persist) return;
    try {
      const rows = await this.persist.load();
      for (const row of rows) {
        const dim = row.dimension as BehavioralDimension;
        if (!ALL_DIMENSIONS.includes(dim)) continue;
        const byDim = this.statsFor(row.key);
        byDim.set(dim, {
          ema: clamp01(row.ema),
          samples: Math.max(0, Math.min(row.samples, this.maxSamples)),
        });
        if (row.updatedAt > (this.lastSeen.get(row.key) ?? 0)) {
          this.lastSeen.set(row.key, row.updatedAt);
        }
        // The count is per key and repeated on each dimension row; take the max.
        const observations = Number.isFinite(row.observations) ? Math.max(0, row.observations!) : 0;
        if (observations > (this.counts.get(row.key) ?? 0)) {
          this.counts.set(row.key, observations);
        }
      }
    } catch {
      // Degrade to in-memory only; the static baseline still carries routing.
    }
  }

  private statsFor(key: string): Map<BehavioralDimension, DimensionStat> {
    let byDim = this.stats.get(key);
    if (!byDim) {
      byDim = new Map();
      this.stats.set(key, byDim);
    }
    return byDim;
  }

  /**
   * Fold one outcome into both the provider-level and model-level accumulators.
   * Safe to call on the hot path: malformed outcomes are ignored.
   */
  ingest(outcome: PhaseOutcome): void {
    if (!outcome?.provider) return;
    const observations = outcomeToDimensionObservations(outcome);
    if (observations.length === 0) return;
    const ts = typeof outcome.timestamp === "number" ? outcome.timestamp : 0;

    const keys = [makeKey(outcome.provider)];
    if (outcome.model) keys.push(makeKey(outcome.provider, outcome.model));

    for (const key of keys) {
      const byDim = this.statsFor(key);
      for (const o of observations) {
        const stat = byDim.get(o.dimension) ?? { ema: o.value, samples: 0 };
        // EMA with a floor on alpha (samples saturate) → never stops adapting.
        const effective = Math.min(stat.samples, this.maxSamples);
        const alpha = o.weight / (effective + o.weight);
        stat.ema = clamp01(stat.ema + alpha * (o.value - stat.ema));
        stat.samples = Math.min(stat.samples + o.weight, this.maxSamples);
        byDim.set(o.dimension, stat);
      }
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      if (ts > (this.lastSeen.get(key) ?? 0)) this.lastSeen.set(key, ts);
    }
    this.dirty = true;
  }

  /**
   * Resolve the accumulator for a dimension: model-level evidence wins, else
   * provider-level. Single source of the model→provider fallback rule, shared by
   * the blend and confidence computations so they can never drift apart.
   */
  private statFor(
    dim: BehavioralDimension,
    providerKey: string,
    modelKey?: string,
  ): DimensionStat | undefined {
    return (modelKey ? this.stats.get(modelKey)?.get(dim) : undefined) ?? this.stats.get(providerKey)?.get(dim);
  }

  /**
   * The blended profile for a provider (or a specific model). Returns a
   * `BehavioralProfile` so it is a drop-in for `getBaselineProfile`. Model-level
   * blends fold the model's own evidence on top of the provider's static prior.
   * Returns `undefined` only when there is neither a baseline nor any evidence.
   */
  getBlendedProfile(provider: string, model?: string): BehavioralProfile | undefined {
    const baseline = getBaselineProfile(provider);
    const providerKey = makeKey(provider);
    const modelKey = model ? makeKey(provider, model) : undefined;
    const hasEvidence =
      this.stats.has(providerKey) || (modelKey ? this.stats.has(modelKey) : false);
    if (!baseline && !hasEvidence) return undefined;

    const scores = {} as Record<BehavioralDimension, number>;
    for (const dim of ALL_DIMENSIONS) {
      const prior = baseline?.scores[dim] ?? NEUTRAL_SCORE;
      const stat = this.statFor(dim, providerKey, modelKey);
      if (!stat || stat.samples <= 0) {
        scores[dim] = prior;
      } else {
        scores[dim] = clamp01(
          (this.priorWeight * prior + stat.samples * stat.ema) / (this.priorWeight + stat.samples),
        );
      }
    }

    const key = modelKey ?? providerKey;
    return {
      providerId: provider.toLowerCase().trim(),
      scores,
      bestWorkloads: baseline?.bestWorkloads ?? [],
      updatedAt: this.lastSeen.get(key) ?? baseline?.updatedAt ?? 0,
    };
  }

  /** Per-dimension blend confidence for a key: samples / (samples + prior). */
  private confidenceFor(provider: string, model?: string): Partial<Record<BehavioralDimension, number>> {
    const providerKey = makeKey(provider);
    const modelKey = model ? makeKey(provider, model) : undefined;
    const out: Partial<Record<BehavioralDimension, number>> = {};
    for (const dim of ALL_DIMENSIONS) {
      const stat = this.statFor(dim, providerKey, modelKey);
      if (stat && stat.samples > 0) {
        out[dim] = stat.samples / (stat.samples + this.priorWeight);
      }
    }
    return out;
  }

  /** Dashboard snapshot for one key. */
  getSnapshot(provider: string, model?: string): DynamicProfileSnapshot | undefined {
    const blended = this.getBlendedProfile(provider, model);
    if (!blended) return undefined;
    const key = model ? makeKey(provider, model) : makeKey(provider);
    return {
      key,
      provider: provider.toLowerCase().trim(),
      model,
      scores: blended.scores,
      confidence: this.confidenceFor(provider, model),
      observationCount: this.counts.get(key) ?? 0,
      updatedAt: this.lastSeen.get(key) ?? 0,
    };
  }

  /** Snapshots for every tracked key (for the dashboard). */
  getAllSnapshots(): DynamicProfileSnapshot[] {
    const out: DynamicProfileSnapshot[] = [];
    for (const key of this.stats.keys()) {
      const { provider, model } = splitKey(key);
      const snap = this.getSnapshot(provider, model);
      if (snap) out.push(snap);
    }
    return out;
  }

  /**
   * Rank models for a workload (the "group models by task" view), best first.
   *
   * @param workload   The task workload to rank for.
   * @param liveModels Optional `provider → Set<modelId>` of currently-supported
   *                   models. When given, only model-level keys whose id is in
   *                   the live set are ranked — de-supported models drop out.
   *                   Provider-level keys are always included as a fallback row.
   */
  rankModelsForWorkload(
    workload: WorkloadType,
    liveModels?: ReadonlyMap<string, ReadonlySet<string>>,
  ): ModelWorkloadRanking[] {
    const weights = WORKLOAD_DIMENSION_WEIGHTS[workload];
    if (!weights) return [];

    const rankings: ModelWorkloadRanking[] = [];
    for (const key of this.stats.keys()) {
      const { provider, model } = splitKey(key);
      if (model && liveModels) {
        const live = liveModels.get(provider.toLowerCase().trim());
        // Prune only against a KNOWN, non-empty live set. An empty or missing set
        // means "couldn't determine" (e.g. a provider that timed out in discovery),
        // NOT "every model de-supported" — keep those rows rather than blanking them.
        if (live && live.size > 0 && !live.has(model)) continue;
      }
      const blended = this.getBlendedProfile(provider, model);
      if (!blended) continue;
      const baseline = getBaselineProfile(provider);
      const conf = this.confidenceFor(provider, model);

      let score = 0;
      let priorScore = 0;
      let weightedConfidence = 0;
      for (const [dim, w] of weights) {
        score += (blended.scores[dim] ?? NEUTRAL_SCORE) * w;
        priorScore += (baseline?.scores[dim] ?? NEUTRAL_SCORE) * w;
        weightedConfidence += (conf[dim] ?? 0) * w;
      }
      rankings.push({
        provider,
        model,
        key,
        score: Math.round(score * 1000) / 1000,
        confidence: Math.round(weightedConfidence * 1000) / 1000,
        drift: Math.round((score - priorScore) * 1000) / 1000,
        observationCount: this.counts.get(key) ?? 0,
      });
    }

    rankings.sort((a, b) => b.score - a.score);
    return rankings;
  }

  /** Serialize all accumulators for persistence. */
  toRows(): ProfileAccumulatorRow[] {
    const rows: ProfileAccumulatorRow[] = [];
    for (const [key, byDim] of this.stats) {
      const updatedAt = this.lastSeen.get(key) ?? 0;
      const observations = this.counts.get(key) ?? 0;
      for (const [dim, stat] of byDim) {
        rows.push({ key, dimension: dim, ema: stat.ema, samples: stat.samples, updatedAt, observations });
      }
    }
    return rows;
  }

  /** Flush accumulators through the persistence boundary. Never throws. */
  async flush(): Promise<void> {
    if (!this.persist || !this.dirty) return;
    try {
      await this.persist.save(this.toRows());
      this.dirty = false;
    } catch {
      // Keep the dirty flag; a later flush may succeed.
    }
  }
}
