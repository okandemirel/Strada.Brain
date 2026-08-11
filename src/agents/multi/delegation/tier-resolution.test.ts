import { describe, it, expect } from "vitest";
import type { ModelInfo } from "../../providers/model-intelligence.js";
import { resolveTierMap, parseTierSpec, TIER_ORDER } from "./tier-resolution.js";

function model(over: Partial<ModelInfo> & Pick<ModelInfo, "id" | "provider">): ModelInfo {
  return {
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
    supportsVision: false,
    supportsThinking: false,
    supportsToolCalling: true,
    supportsStreaming: true,
    lastUpdated: 0,
    ...over,
  };
}

const OPUS = model({
  id: "claude-opus-5", provider: "claude",
  contextWindow: 1_000_000, maxOutputTokens: 128_000,
  inputPricePerMillion: 5, outputPricePerMillion: 25,
  supportsVision: true, supportsThinking: true,
});
const SONNET = model({
  id: "claude-sonnet-5", provider: "claude",
  contextWindow: 1_000_000, maxOutputTokens: 128_000,
  inputPricePerMillion: 3, outputPricePerMillion: 15,
  supportsVision: true, supportsThinking: true,
});
const HAIKU = model({
  id: "claude-haiku-4-5", provider: "claude",
  contextWindow: 200_000, maxOutputTokens: 64_000,
  inputPricePerMillion: 1, outputPricePerMillion: 5,
  supportsVision: true, supportsThinking: true,
});
const LLAMA = model({
  id: "llama3.3", provider: "ollama",
  contextWindow: 128_000, maxOutputTokens: 8_000,
  inputPricePerMillion: 0, outputPricePerMillion: 0,
});
const CATALOG = [OPUS, SONNET, HAIKU, LLAMA];
const ALL_PROVIDERS = ["claude", "ollama"];

describe("resolveTierMap — pins", () => {
  it("uses an operator pin verbatim and never derives over it", () => {
    const r = resolveTierMap({
      configured: { premium: "claude:some-private-deployment" },
      catalog: CATALOG,
      availableProviders: ALL_PROVIDERS,
    });
    expect(r.tiers.premium).toBe("claude:some-private-deployment");
    const d = r.derivations.find((x) => x.tier === "premium")!;
    expect(d.source).toBe("pin");
  });

  it("passes an unparseable pin through rather than dropping it", () => {
    const r = resolveTierMap({
      configured: { standard: "no-colon-here" },
      catalog: CATALOG,
      availableProviders: ALL_PROVIDERS,
    });
    expect(r.tiers.standard).toBe("no-colon-here");
    expect(r.derivations.find((x) => x.tier === "standard")!.reason).toContain("unparseable");
  });

  it("treats whitespace-only config as empty and derives", () => {
    const r = resolveTierMap({
      configured: { standard: "   " },
      catalog: CATALOG,
      availableProviders: ALL_PROVIDERS,
    });
    expect(r.derivations.find((x) => x.tier === "standard")!.source).toBe("derived");
  });
});

describe("resolveTierMap — derivation", () => {
  it("derives every tier when nothing is configured", () => {
    const r = resolveTierMap({
      configured: {},
      catalog: CATALOG,
      availableProviders: ALL_PROVIDERS,
    });
    for (const tier of TIER_ORDER) {
      expect(r.tiers[tier], `tier ${tier}`).toBeTruthy();
    }
  });

  it("picks the most capable model for premium regardless of price", () => {
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    // Opus and Sonnet share context/output/thinking; Opus costs more, and at
    // premium weighting capability dominates but does not separate them — the
    // tie-break is cost, so Sonnet wins. What must hold is that premium picks
    // one of the two frontier models, never Haiku.
    expect(["claude:claude-opus-5", "claude:claude-sonnet-5"]).toContain(r.tiers.premium);
  });

  it("picks a cheaper model for cheap than for premium", () => {
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    expect(r.tiers.cheap).toBe("claude:claude-haiku-4-5");
    expect(r.tiers.cheap).not.toBe(r.tiers.premium);
  });

  it("routes local to a zero-cost local provider", () => {
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    expect(r.tiers.local).toBe("ollama:llama3.3");
  });

  it("never puts a local model in a paid tier", () => {
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    for (const tier of ["cheap", "standard", "premium"] as const) {
      expect(r.tiers[tier], `tier ${tier}`).not.toContain("ollama:");
    }
  });
});

describe("resolveTierMap — availability", () => {
  it("ignores models whose provider has no credential", () => {
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ["ollama"],
    });
    expect(r.tiers.local).toBe("ollama:llama3.3");
    // No paid provider is reachable, so the paid tiers must resolve to nothing
    // rather than to a model the deployment cannot call.
    expect(r.tiers.premium).toBeUndefined();
    expect(r.derivations.find((x) => x.tier === "premium")!.source).toBe("unresolved");
  });

  it("reports unresolved rather than inventing a fallback on an empty catalog", () => {
    const r = resolveTierMap({
      configured: {}, catalog: [], availableProviders: ALL_PROVIDERS,
    });
    expect(Object.keys(r.tiers)).toHaveLength(0);
    expect(r.derivations.every((d) => d.source === "unresolved")).toBe(true);
  });

  it("still honors a pin for a provider with no credential", () => {
    // The operator may know something the credential map does not (a proxy,
    // a gateway). A pin is an instruction, not a suggestion.
    const r = resolveTierMap({
      configured: { premium: "claude:claude-opus-5" },
      catalog: CATALOG,
      availableProviders: ["ollama"],
    });
    expect(r.tiers.premium).toBe("claude:claude-opus-5");
  });
});

describe("resolveTierMap — excludes non-tool models", () => {
  it("never selects a model that cannot call tools", () => {
    const noTools = model({
      id: "text-only", provider: "claude",
      contextWindow: 1_000_000, maxOutputTokens: 128_000,
      inputPricePerMillion: 0.01, outputPricePerMillion: 0.01,
      supportsToolCalling: false,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [noTools, HAIKU], availableProviders: ["claude"],
    });
    // `text-only` is far cheaper and higher-context, so it would win every
    // paid tier if tool support were not a hard gate.
    for (const tier of TIER_ORDER) {
      expect(r.tiers[tier] ?? "").not.toContain("text-only");
    }
  });
});

describe("resolveTierMap — observed behavior", () => {
  it("lets a strong observation promote an otherwise-equal model", () => {
    // Asserted on `cheap` — the first paid tier resolved — so the
    // distinctness rule cannot confound what this test is measuring.
    const a = model({ id: "a", provider: "claude", contextWindow: 500_000 });
    const b = model({ id: "b", provider: "claude", contextWindow: 500_000 });
    const base = resolveTierMap({
      configured: {}, catalog: [a, b], availableProviders: ["claude"],
    });
    expect(base.tiers.cheap).toBe("claude:a"); // tie → first wins

    const withObs = resolveTierMap({
      configured: {}, catalog: [a, b], availableProviders: ["claude"],
      behavioralScore: (_p, id) => (id === "b" ? 1 : 0),
    });
    expect(withObs.tiers.cheap).toBe("claude:b");
  });

  it("does not let observation alone override a large capability gap at premium", () => {
    // premium's contract is "most capable available". Even a perfect observed
    // record must not promote a small model into it, or the tier reserved for
    // the hardest work silently becomes the cheap tier.
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
      behavioralScore: (_p, id) => (id === "claude-haiku-4-5" ? 1 : 0),
    });
    expect(r.tiers.premium).not.toBe("claude:claude-haiku-4-5");
  });

  it("observation is load-bearing for the cost-sensitive tiers", () => {
    // Asserted over the whole assignment: a strong observation must change
    // *something*. Pinning it to one tier is brittle, because promoting a
    // model into `cheap` then pushes `standard` elsewhere via distinctness —
    // both are the mechanism working, not a regression.
    const without = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    const with_ = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
      behavioralScore: (_p, id) => (id === "claude-opus-5" ? 1 : 0),
    });
    expect(with_.tiers).not.toEqual(without.tiers);
    // And specifically: the observed model must now hold a cost-sensitive tier
    // it did not hold before.
    expect(with_.tiers.cheap).toBe("claude:claude-opus-5");
    expect(without.tiers.cheap).not.toBe("claude:claude-opus-5");
  });

  it("ignores a non-finite observation instead of poisoning the score", () => {
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
      behavioralScore: () => Number.NaN,
    });
    expect(r.tiers.premium).toBeTruthy();
    expect(r.tiers.cheap).toBe("claude:claude-haiku-4-5");
  });
});

describe("resolveTierMap — real-catalog hazards", () => {
  // Every case here reproduces something the FIRST live run actually did
  // against a 2,339-model LiteLLM catalog.

  it("never selects an account-specific fine-tune", () => {
    // The live run picked `ft:gpt-4.1-nano-2025-04-14` for two tiers because
    // its 1M context outscored every frontier model.
    const ft = model({
      id: "ft:gpt-4.1-nano-2025-04-14", provider: "openai",
      contextWindow: 1_047_576, maxOutputTokens: 32_000,
      inputPricePerMillion: 0.2, outputPricePerMillion: 0.8,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [ft, SONNET], availableProviders: ["openai", "claude"],
    });
    for (const tier of TIER_ORDER) {
      expect(r.tiers[tier] ?? "").not.toContain("ft:");
    }
  });

  it("does not treat an ollama '-cloud' tag as a local model", () => {
    // `ollama:deepseek-v3.1:671b-cloud` won the local tier despite being hosted.
    const cloud = model({
      id: "deepseek-v3.1:671b-cloud", provider: "ollama",
      contextWindow: 163_840, inputPricePerMillion: 0, outputPricePerMillion: 0,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [cloud, LLAMA], availableProviders: ["ollama"],
    });
    expect(r.tiers.local).toBe("ollama:llama3.3");
  });

  it("excludes specialized non-chat endpoints", () => {
    const dr = model({
      id: "o4-mini-deep-research", provider: "openai",
      contextWindow: 200_000, supportsThinking: true,
      inputPricePerMillion: 2, outputPricePerMillion: 8,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [dr, SONNET], availableProviders: ["openai", "claude"],
    });
    expect(r.tiers.premium).not.toContain("deep-research");
  });

  it("treats a dated snapshot and its alias as the same model", () => {
    // The live run gave cheap=`gpt-4o-mini-search-preview` and
    // standard=`gpt-4o-mini-search-preview-2025-03-11`: two spec strings, one
    // model, so escalating from cheap to standard re-ran the same thing.
    const alias = model({
      id: "gpt-4o-mini", provider: "openai",
      contextWindow: 128_000, inputPricePerMillion: 0.15, outputPricePerMillion: 0.6,
    });
    const snapshot = model({
      id: "gpt-4o-mini-2025-03-11", provider: "openai",
      contextWindow: 128_000, inputPricePerMillion: 0.15, outputPricePerMillion: 0.6,
    });
    const other = model({
      id: "gpt-4.1", provider: "openai",
      contextWindow: 1_000_000, maxOutputTokens: 32_000,
      inputPricePerMillion: 2, outputPricePerMillion: 8,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [alias, snapshot, other], availableProviders: ["openai"],
    });
    expect(r.tiers.cheap).not.toBe(r.tiers.standard);
    const bothAreSameFamily =
      String(r.tiers.cheap).includes("gpt-4o-mini") &&
      String(r.tiers.standard).includes("gpt-4o-mini");
    expect(bothAreSameFamily).toBe(false);
  });

  it("excludes web-search-specialized endpoints but keeps ordinary previews", () => {
    const searchy = model({
      id: "gpt-4o-mini-search-preview", provider: "openai",
      contextWindow: 128_000, inputPricePerMillion: 0.15, outputPricePerMillion: 0.6,
    });
    const ordinaryPreview = model({
      id: "gemini-3-flash-preview", provider: "gemini",
      contextWindow: 1_000_000, inputPricePerMillion: 0.5, outputPricePerMillion: 3,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [searchy, ordinaryPreview],
      availableProviders: ["openai", "gemini"],
    });
    const all = Object.values(r.tiers).join(" ");
    expect(all).not.toContain("search-preview");
    expect(all).toContain("gemini-3-flash-preview");
  });

  it.each([
    "gpt-4o-mini-audio-preview",
    "gpt-4o-realtime-preview",
    "gpt-4o-transcribe",
    "some-image-gen-model",
  ])("never selects the non-chat modality model %s", (id) => {
    // These advertise tool support and a low per-token price, which was enough
    // for `gpt-4o-mini-audio-preview` to win the cheap tier on a live run.
    const modal = model({
      id, provider: "openai",
      contextWindow: 128_000, inputPricePerMillion: 0.15, outputPricePerMillion: 0.6,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [modal, SONNET], availableProviders: ["openai", "claude"],
    });
    expect(Object.values(r.tiers).join(" ")).not.toContain(id);
  });

  it("refuses to auto-derive an absurdly expensive model", () => {
    // A live run derived `o1-pro-2025-03-19` at $487.50/1M for premium purely
    // because it topped the price percentile — five times the cost of a newer,
    // larger-context model in the same catalog.
    const legacyExpensive = model({
      id: "o1-pro-2025-03-19", provider: "openai",
      contextWindow: 200_000, maxOutputTokens: 100_000,
      inputPricePerMillion: 150, outputPricePerMillion: 600,
      supportsThinking: true,
    });
    const frontier = model({
      id: "gpt-5-pro", provider: "openai",
      contextWindow: 400_000, maxOutputTokens: 128_000,
      inputPricePerMillion: 15, outputPricePerMillion: 120,
      supportsThinking: true,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [legacyExpensive, frontier], availableProviders: ["openai"],
    });
    expect(r.tiers.premium).toBe("openai:gpt-5-pro");
  });

  it("still honors a pin above the auto-derivation price ceiling", () => {
    // The ceiling constrains automatic choice, not the operator's.
    const r = resolveTierMap({
      configured: { premium: "openai:o1-pro-2025-03-19" },
      catalog: [], availableProviders: ["openai"],
    });
    expect(r.tiers.premium).toBe("openai:o1-pro-2025-03-19");
  });

  it("gives each paid tier a distinct model when candidates allow", () => {
    // cheap === standard collapses the escalation ladder: escalating would
    // re-run the identical model and fail identically.
    const r = resolveTierMap({
      configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    const paid = [r.tiers.cheap, r.tiers.standard, r.tiers.premium];
    expect(new Set(paid).size).toBe(paid.length);
  });

  it("reuses a model rather than leaving a tier unresolved when it is the only option", () => {
    const only = model({ id: "solo", provider: "claude" });
    const r = resolveTierMap({
      configured: {}, catalog: [only], availableProviders: ["claude"],
    });
    expect(r.tiers.cheap).toBe("claude:solo");
    expect(r.tiers.premium).toBe("claude:solo");
  });

  it("prefers a pricier model for premium when specs are comparable", () => {
    // Spec sheets cannot separate a frontier model from a nano model with a
    // big context window; the vendor's own price can.
    const nano = model({
      id: "nano", provider: "openai",
      contextWindow: 1_000_000, maxOutputTokens: 128_000,
      inputPricePerMillion: 0.1, outputPricePerMillion: 0.4,
      supportsThinking: true, supportsVision: true,
    });
    const frontier = model({
      id: "frontier", provider: "openai",
      contextWindow: 1_000_000, maxOutputTokens: 128_000,
      inputPricePerMillion: 5, outputPricePerMillion: 25,
      supportsThinking: true, supportsVision: true,
    });
    const r = resolveTierMap({
      configured: {}, catalog: [nano, frontier], availableProviders: ["openai"],
    });
    expect(r.tiers.premium).toBe("openai:frontier");
    expect(r.tiers.cheap).toBe("openai:nano");
  });
});

describe("resolveTierMap — determinism & reporting", () => {
  it("is deterministic across repeated calls", () => {
    const once = resolveTierMap({ configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS });
    const twice = resolveTierMap({ configured: {}, catalog: CATALOG, availableProviders: ALL_PROVIDERS });
    expect(twice.tiers).toEqual(once.tiers);
  });

  it("reports a reason for every tier so the choice is auditable", () => {
    const r = resolveTierMap({
      configured: { premium: "claude:claude-opus-5" },
      catalog: CATALOG, availableProviders: ALL_PROVIDERS,
    });
    expect(r.derivations).toHaveLength(TIER_ORDER.length);
    for (const d of r.derivations) {
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("parseTierSpec", () => {
  it.each([
    ["claude:claude-opus-5", { provider: "claude", model: "claude-opus-5" }],
    ["ollama:llama3.3", { provider: "ollama", model: "llama3.3" }],
    ["opencode:opencode/gpt-5.5", { provider: "opencode", model: "opencode/gpt-5.5" }],
  ])("parses %s", (spec, expected) => {
    expect(parseTierSpec(spec)).toEqual(expected);
  });

  it.each(["", "nocolon", ":leading", "trailing:"])("rejects %o", (spec) => {
    expect(parseTierSpec(spec)).toBeUndefined();
  });
});
