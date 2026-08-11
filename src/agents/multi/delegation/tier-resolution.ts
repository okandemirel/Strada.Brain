/**
 * Delegation Tier Resolution
 *
 * Turns the four delegation tiers into concrete `provider:model` specs.
 *
 * Two sources, in strict precedence:
 *
 *  1. **Operator pin** — a non-empty `provider:model` in config. Used verbatim,
 *     never second-guessed, even if the catalog does not know the model (the
 *     operator may be pointing at a private deployment or a model newer than
 *     the last catalog refresh).
 *  2. **Derivation** — an empty config value means "pick the best available
 *     model for this tier". Candidates come from the live model catalog,
 *     restricted to providers this deployment holds credentials for, and are
 *     ranked by the same signals `DelegationManager.scoreCandidate` uses at
 *     dispatch time: context window, output ceiling, thinking/tool support,
 *     price, and — when supplied — the observed behavioral score for that
 *     provider/model.
 *
 * Keeping derivation pure (catalog in, specs out) means the whole policy is
 * unit-testable without a DB, a network, or a provider instance.
 */

import type { ModelInfo } from "../../providers/model-intelligence.js";
import type { ModelTier } from "./delegation-types.js";

/** Tiers in ascending capability order. */
export const TIER_ORDER: readonly ModelTier[] = ["local", "cheap", "standard", "premium"] as const;

/**
 * Observed-quality lookup. Returns a 0..1 score for a provider (or a specific
 * `provider::model`), or `undefined` when there is no observation yet.
 *
 * This is the seam onto `DynamicBehavioralProfiles`; keeping it as a narrow
 * function type means tier resolution never depends on that module directly.
 */
export type BehavioralScoreLookup = (provider: string, modelId: string) => number | undefined;

export interface TierDerivation {
  readonly tier: ModelTier;
  /** Resolved `provider:model`, or `undefined` when nothing qualified. */
  readonly spec?: string;
  /** `pin` when the operator configured it, `derived` when the scorer chose. */
  readonly source: "pin" | "derived" | "unresolved";
  /** Human-readable reason, surfaced in boot logs and the dashboard. */
  readonly reason: string;
  /** Score of the winning candidate (derived only). */
  readonly score?: number;
  /** How many catalog models qualified for this tier. */
  readonly candidateCount?: number;
}

export interface ResolveTierMapParams {
  /** Config values; empty string means "derive". */
  readonly configured: Partial<Record<ModelTier, string>>;
  /** Every model the catalog currently knows about. */
  readonly catalog: readonly ModelInfo[];
  /** Provider names this deployment can actually call. */
  readonly availableProviders: readonly string[];
  /** Optional observed-quality signal. */
  readonly behavioralScore?: BehavioralScoreLookup;
}

export interface ResolveTierMapResult {
  /** Fully resolved map; a tier with no viable candidate is omitted. */
  readonly tiers: Partial<Record<ModelTier, string>>;
  readonly derivations: readonly TierDerivation[];
}

/** Providers that run locally and therefore cost nothing per token. */
const LOCAL_PROVIDERS = new Set(["ollama", "llamacpp", "lmstudio", "vllm"]);

/**
 * Ids that must never be auto-selected, even when they score well.
 *
 * A real provider catalog (LiteLLM returns ~2,300 entries) is not a curated
 * list of chat models. Without this filter the first live run picked
 * `ft:gpt-4.1-nano-2025-04-14` — someone's private fine-tune — for two tiers,
 * because its 1M context window outscored every frontier model.
 */
const EXCLUDED_ID_PATTERNS: readonly RegExp[] = [
  // Account-specific fine-tunes. Not a defensible default for anyone else.
  /^ft:/i,
  // Ollama "-cloud" tags are hosted, not local — selecting one for the local
  // tier defeats the entire point of that tier.
  /[-:]cloud$/i,
  // Specialized agent endpoints with their own protocols/pricing, not
  // general-purpose chat models. Note this targets `search-preview`
  // specifically, NOT every `-preview` model — plenty of mainline models ship
  // under a preview tag and are perfectly good general choices.
  /deep-research/i,
  /search-(preview|api)/i,
  // Non-chat modalities that can still advertise tool support and a cheap
  // per-token price, which is enough to win a cost-sensitive tier outright.
  // (`gpt-4o-mini-audio-preview` won `cheap` on a live run.)
  /\b(whisper|tts|dall-e|embedding|moderation|rerank)\b/i,
  /(audio|realtime|transcribe|speech|image|video)/i,
];

/**
 * Blended $/1M ceiling for AUTO-DERIVED tiers.
 *
 * Price is used as a capability signal for `premium`, but the top of a real
 * catalog is legacy specialty pricing, not the frontier: a live run derived
 * `o1-pro-2025-03-19` at $487.50/1M — five times the price of a newer, larger-
 * context model in the same catalog — purely because it was the most
 * expensive thing available. Nothing this costly should become a default
 * without the operator saying so, and a pin always can.
 */
export const MAX_AUTO_DERIVED_BLENDED_PRICE = 150;

function isSelectable(m: ModelInfo): boolean {
  if (EXCLUDED_ID_PATTERNS.some((re) => re.test(m.id))) return false;
  if (blendedPrice(m) > MAX_AUTO_DERIVED_BLENDED_PRICE) return false;
  return true;
}

/**
 * Collapse a model id to its family, so a dated snapshot and its alias count
 * as the same model for distinctness purposes.
 *
 * The first live run gave `cheap` = `gpt-4o-mini-search-preview` and
 * `standard` = `gpt-4o-mini-search-preview-2025-03-11` — two spec strings,
 * one model, and therefore an escalation ladder that escalates to itself.
 */
export function familyKey(provider: string, id: string): string {
  const base = id
    // Trailing dated snapshot: -2025-03-11 / -20250311 / @20250311
    .replace(/[-@]\d{4}-?\d{2}-?\d{2}$/, "")
    // Trailing -latest / -preview markers that alias the same family.
    .replace(/-(latest|preview)$/i, "");
  return `${provider.toLowerCase()}:${base.toLowerCase()}`;
}

/** Blended $/1M price used for cost comparisons — output is weighted higher
 *  because delegated sub-agent turns are output-heavy. */
function blendedPrice(m: ModelInfo): number {
  return m.inputPricePerMillion * 0.25 + m.outputPricePerMillion * 0.75;
}

function isLocal(m: ModelInfo): boolean {
  return LOCAL_PROVIDERS.has(m.provider.toLowerCase()) || blendedPrice(m) === 0;
}

/** Normalize a value into 0..1 against a soft ceiling. */
function ratio(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value / ceiling, 1);
}

/**
 * Cheapness on 0..1. Free is 1; the curve is hyperbolic so the meaningful
 * spread sits in the $0–$30 range where real models actually live, instead of
 * being flattened by a single expensive outlier.
 */
function cheapness(m: ModelInfo): number {
  const price = blendedPrice(m);
  if (price <= 0) return 1;
  return 1 / (1 + price / 5);
}

/** Capability score independent of price. */
function capability(m: ModelInfo): number {
  return (
    ratio(m.contextWindow, 1_000_000) * 0.4 +
    ratio(m.maxOutputTokens, 128_000) * 0.2 +
    (m.supportsThinking ? 0.25 : 0) +
    (m.supportsVision ? 0.15 : 0)
  );
}

/**
 * Per-tier weighting of capability vs cost. These mirror the intent of
 * `DelegationManager.scoreCandidate`: `local` cares about being local, `cheap`
 * about price, `premium` about raw capability, `standard` balances the two.
 */
const TIER_WEIGHTS: Record<ModelTier, { capability: number; cheapness: number }> = {
  local: { capability: 0.35, cheapness: 0.65 },
  cheap: { capability: 0.25, cheapness: 0.75 },
  standard: { capability: 0.6, cheapness: 0.4 },
  // For premium the second term is the price PERCENTILE, not cheapness — see
  // scoreFor. 0.55/0.45 keeps spec capability in the lead while letting the
  // vendor's own pricing break ties that spec sheets cannot.
  premium: { capability: 0.55, cheapness: 0.45 },
};

/**
 * Weight given to observed behavior when an observation exists; the
 * catalog-derived score keeps the remainder.
 *
 * Tier-aware on purpose. `premium`'s contract is "the most capable model
 * available", so spec-sheet capability must dominate there — otherwise a
 * cheap model with a good short-term record gets promoted into the tier
 * reserved for the hardest work. The cost-sensitive tiers weight observation
 * higher, because for them real-world reliability matters more than headline
 * context-window numbers.
 *
 * Note the caller's lookup is expected to be confidence-blended already
 * (`DynamicBehavioralProfiles` folds sample count into its EMA before
 * returning), so this weight governs *how much a settled observation counts*,
 * not how much early noise counts.
 */
const OBSERVED_WEIGHT: Record<ModelTier, number> = {
  local: 0.3,
  cheap: 0.3,
  standard: 0.3,
  premium: 0.15,
};

function qualifies(m: ModelInfo, tier: ModelTier): boolean {
  // Delegated work always calls tools; a model that cannot is never a
  // candidate for any tier.
  if (!m.supportsToolCalling) return false;
  if (!isSelectable(m)) return false;
  if (tier === "local") return isLocal(m);
  // Paid tiers exclude local models: a local model would otherwise dominate
  // `cheap` on price alone and silently disable remote delegation.
  return !isLocal(m);
}

/**
 * Price rank within the candidate set, 0 (cheapest) … 1 (priciest).
 *
 * Used only by `premium`, where price is read as a *capability* signal rather
 * than a cost: vendors price by capability, and spec sheets alone cannot tell
 * a frontier model from a nano model with a large context window. Percentile
 * rather than absolute price so the signal is stable whether the catalog holds
 * 20 models or 2,300.
 */
function pricePercentiles(candidates: readonly ModelInfo[]): Map<string, number> {
  const sorted = [...candidates].sort((a, b) => blendedPrice(a) - blendedPrice(b));
  const out = new Map<string, number>();
  const n = sorted.length;
  for (let i = 0; i < n; i++) {
    out.set(sorted[i]!.id, n <= 1 ? 1 : i / (n - 1));
  }
  return out;
}

function scoreFor(
  m: ModelInfo,
  tier: ModelTier,
  behavioralScore?: BehavioralScoreLookup,
  pricePercentile?: Map<string, number>,
): number {
  const w = TIER_WEIGHTS[tier];
  const base =
    tier === "premium"
      // For premium, a HIGH price is evidence of a high-capability model, so
      // it replaces the cheapness term rather than being weighed against it.
      ? capability(m) * w.capability + (pricePercentile?.get(m.id) ?? 0) * (1 - w.capability)
      : capability(m) * w.capability + cheapness(m) * w.cheapness;
  const observed = behavioralScore?.(m.provider, m.id);
  if (observed === undefined || !Number.isFinite(observed)) return base;
  const ow = OBSERVED_WEIGHT[tier];
  return base * (1 - ow) + observed * ow;
}

/** Parse a `provider:model` spec. Returns `undefined` when malformed. */
export function parseTierSpec(spec: string): { provider: string; model: string } | undefined {
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) return undefined;
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
}

/**
 * Resolve every tier. Pins win; empty tiers are derived from the catalog.
 *
 * A tier with no viable candidate is reported as `unresolved` rather than
 * silently falling back to an arbitrary model — the caller decides whether
 * that is fatal (it is not: delegation simply skips that tier).
 */
export function resolveTierMap(params: ResolveTierMapParams): ResolveTierMapResult {
  const { configured, catalog, availableProviders, behavioralScore } = params;
  const available = new Set(availableProviders.map((p) => p.toLowerCase()));
  const reachable = catalog.filter((m) => available.has(m.provider.toLowerCase()));

  const tiers: Partial<Record<ModelTier, string>> = {};
  const derivations: TierDerivation[] = [];
  /** Model FAMILIES already claimed by an earlier tier (pins included). A
   *  dated snapshot and its alias share a family, so they cannot occupy two
   *  tiers between them. */
  const usedFamilies = new Set<string>();

  for (const tier of TIER_ORDER) {
    const pinned = configured[tier]?.trim();
    if (pinned) {
      tiers[tier] = pinned;
      {
        const p = parseTierSpec(pinned);
        if (p) usedFamilies.add(familyKey(p.provider, p.model));
      }
      const parsed = parseTierSpec(pinned);
      derivations.push({
        tier,
        spec: pinned,
        source: "pin",
        reason: parsed
          ? `operator pin (${parsed.provider}:${parsed.model})`
          : `operator pin (unparseable spec "${pinned}" — passed through verbatim)`,
      });
      continue;
    }

    const candidates = reachable.filter((m) => qualifies(m, tier));
    if (candidates.length === 0) {
      derivations.push({
        tier,
        source: "unresolved",
        reason:
          reachable.length === 0
            ? "no catalog model belongs to a provider this deployment has credentials for"
            : `no reachable model qualifies for the "${tier}" tier`,
        candidateCount: 0,
      });
      continue;
    }

    const percentiles = tier === "premium" ? pricePercentiles(candidates) : undefined;
    const scored = candidates
      .map((c) => ({ model: c, score: scoreFor(c, tier, behavioralScore, percentiles) }))
      // Descending; ties keep catalog order, so the result is deterministic.
      .sort((a, b) => b.score - a.score);

    // Prefer a model no other tier already took. Two tiers resolving to the
    // same spec collapses the escalation ladder — `cheap` escalating to
    // `standard` would re-run the identical model and re-fail identically.
    // If every candidate is taken, reuse rather than leave the tier unresolved.
    const fresh = scored.find((s) => !usedFamilies.has(familyKey(s.model.provider, s.model.id)));
    const chosen = fresh ?? scored[0]!;
    const best = chosen.model;
    const bestScore = chosen.score;

    const spec = `${best.provider}:${best.id}`;
    usedFamilies.add(familyKey(best.provider, best.id));
    tiers[tier] = spec;
    derivations.push({
      tier,
      spec,
      source: "derived",
      score: bestScore,
      candidateCount: candidates.length,
      reason:
        `best of ${candidates.length} reachable model(s) for "${tier}" — ` +
        `ctx ${best.contextWindow.toLocaleString("en-US")}, ` +
        `$${blendedPrice(best).toFixed(2)}/1M blended` +
        (best.supportsThinking ? ", thinking" : ""),
    });
  }

  return { tiers, derivations };
}
