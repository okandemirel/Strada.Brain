import { describe, it, expect } from "vitest";
import {
  SYSTEM_PRESETS,
  PROVIDER_MODEL_OPTIONS,
  getPreset,
  listPresets,
  getProviderModels,
  type PresetName,
  type SystemPreset,
} from "./presets.js";

const ALL_PRESET_NAMES: PresetName[] = ["free", "budget", "balanced", "performance", "premium"];

// ---------------------------------------------------------------------------
// SYSTEM_PRESETS structure
// ---------------------------------------------------------------------------
describe("SYSTEM_PRESETS", () => {
  it("contains exactly 5 presets", () => {
    expect(Object.keys(SYSTEM_PRESETS)).toHaveLength(5);
  });

  it("contains all expected preset names", () => {
    for (const name of ALL_PRESET_NAMES) {
      expect(SYSTEM_PRESETS).toHaveProperty(name);
    }
  });

  it("each preset.name matches its key in the record", () => {
    for (const [key, preset] of Object.entries(SYSTEM_PRESETS)) {
      expect(preset.name).toBe(key);
    }
  });

  describe.each(ALL_PRESET_NAMES)("preset '%s'", (name) => {
    let preset: SystemPreset;

    beforeAll(() => {
      preset = SYSTEM_PRESETS[name];
    });

    // --- Required string fields ---
    it("has a non-empty label", () => {
      expect(preset.label).toBeTruthy();
      expect(typeof preset.label).toBe("string");
    });

    it("has a non-empty description", () => {
      expect(preset.description).toBeTruthy();
      expect(typeof preset.description).toBe("string");
    });

    it("has a non-empty estimatedMonthlyCost", () => {
      expect(preset.estimatedMonthlyCost).toBeTruthy();
      expect(preset.estimatedMonthlyCost.startsWith("$")).toBe(true);
    });

    it("has a non-empty providerChain", () => {
      expect(preset.providerChain).toBeTruthy();
      expect(preset.providerChain.split(",").length).toBeGreaterThanOrEqual(1);
    });

    it("has at least one entry in providerModels", () => {
      expect(Object.keys(preset.providerModels).length).toBeGreaterThanOrEqual(1);
    });

    // --- Delegation tiers ---
    it("has all four delegation tiers defined", () => {
      expect(preset.delegationTierLocal).toBeTruthy();
      expect(preset.delegationTierCheap).toBeTruthy();
      expect(preset.delegationTierStandard).toBeTruthy();
      expect(preset.delegationTierPremium).toBeTruthy();
    });

    it("delegation tiers follow provider:model format", () => {
      const tierPattern = /^[a-z]+:.+$/;
      expect(preset.delegationTierLocal).toMatch(tierPattern);
      expect(preset.delegationTierCheap).toMatch(tierPattern);
      expect(preset.delegationTierStandard).toMatch(tierPattern);
      expect(preset.delegationTierPremium).toMatch(tierPattern);
    });

    // --- Embedding ---
    it("has embeddingProvider and embeddingModel", () => {
      expect(preset.embeddingProvider).toBeTruthy();
      expect(preset.embeddingModel).toBeTruthy();
    });

    // --- Pricing structure ---
    it("has complete pricing.chat object", () => {
      expect(preset.pricing.chat).toBeDefined();
      expect(typeof preset.pricing.chat.input).toBe("number");
      expect(typeof preset.pricing.chat.output).toBe("number");
      expect(preset.pricing.chat.input).toBeGreaterThanOrEqual(0);
      expect(preset.pricing.chat.output).toBeGreaterThanOrEqual(0);
      expect(preset.pricing.chat.model).toBeTruthy();
    });

    it("has complete pricing.embedding object", () => {
      expect(preset.pricing.embedding).toBeDefined();
      expect(typeof preset.pricing.embedding.perMillion).toBe("number");
      expect(preset.pricing.embedding.perMillion).toBeGreaterThanOrEqual(0);
      expect(preset.pricing.embedding.model).toBeTruthy();
    });

    it("has complete pricing.delegation.cheap object", () => {
      const cheap = preset.pricing.delegation.cheap;
      expect(typeof cheap.input).toBe("number");
      expect(typeof cheap.output).toBe("number");
      expect(cheap.input).toBeGreaterThanOrEqual(0);
      expect(cheap.output).toBeGreaterThanOrEqual(0);
      expect(cheap.model).toBeTruthy();
    });

    it("has complete pricing.delegation.premium object", () => {
      const premium = preset.pricing.delegation.premium;
      expect(typeof premium.input).toBe("number");
      expect(typeof premium.output).toBe("number");
      expect(premium.input).toBeGreaterThanOrEqual(0);
      expect(premium.output).toBeGreaterThanOrEqual(0);
      expect(premium.model).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Pricing monotonicity: presets ordered from cheapest to most expensive
// ---------------------------------------------------------------------------
describe("pricing ordering", () => {
  it("chat input pricing is non-decreasing across presets (free -> premium)", () => {
    const prices = ALL_PRESET_NAMES.map((n) => SYSTEM_PRESETS[n].pricing.chat.input);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
  });

  it("chat output pricing is non-decreasing across presets (free -> premium)", () => {
    const prices = ALL_PRESET_NAMES.map((n) => SYSTEM_PRESETS[n].pricing.chat.output);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
  });

  it("free preset has zero cost for all pricing fields", () => {
    const free = SYSTEM_PRESETS.free;
    expect(free.pricing.chat.input).toBe(0);
    expect(free.pricing.chat.output).toBe(0);
    expect(free.pricing.embedding.perMillion).toBe(0);
    expect(free.pricing.delegation.cheap.input).toBe(0);
    expect(free.pricing.delegation.cheap.output).toBe(0);
    expect(free.pricing.delegation.premium.input).toBe(0);
    expect(free.pricing.delegation.premium.output).toBe(0);
  });

  it("non-free presets have at least one non-zero pricing field", () => {
    for (const name of ALL_PRESET_NAMES.filter((n) => n !== "free")) {
      const p = SYSTEM_PRESETS[name].pricing;
      const hasNonZero =
        p.chat.input > 0 ||
        p.chat.output > 0 ||
        p.embedding.perMillion > 0 ||
        p.delegation.cheap.input > 0 ||
        p.delegation.premium.input > 0;
      expect(hasNonZero).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Free preset specifics
// ---------------------------------------------------------------------------
describe("free preset", () => {
  it("uses only ollama provider", () => {
    const free = SYSTEM_PRESETS.free;
    expect(free.providerChain).toBe("ollama");
    expect(Object.keys(free.providerModels)).toEqual(["ollama"]);
  });

  it("uses ollama for embedding", () => {
    expect(SYSTEM_PRESETS.free.embeddingProvider).toBe("ollama");
  });

  it("has $0 estimated monthly cost", () => {
    expect(SYSTEM_PRESETS.free.estimatedMonthlyCost).toBe("$0");
  });
});

// ---------------------------------------------------------------------------
// getPreset()
// ---------------------------------------------------------------------------
describe("getPreset", () => {
  it.each(ALL_PRESET_NAMES)("returns the correct preset for '%s'", (name) => {
    const preset = getPreset(name);
    expect(preset).toBeDefined();
    expect(preset!.name).toBe(name);
    expect(preset).toBe(SYSTEM_PRESETS[name]);
  });

  it("returns undefined for an unknown preset name", () => {
    expect(getPreset("nonexistent")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getPreset("")).toBeUndefined();
  });

  it("is case-sensitive (uppercase returns undefined)", () => {
    expect(getPreset("FREE")).toBeUndefined();
    expect(getPreset("Budget")).toBeUndefined();
    expect(getPreset("BALANCED")).toBeUndefined();
  });

  it("returns undefined for whitespace-padded names", () => {
    expect(getPreset(" free")).toBeUndefined();
    expect(getPreset("free ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listPresets()
// ---------------------------------------------------------------------------
describe("listPresets", () => {
  it("returns exactly 5 entries", () => {
    expect(listPresets()).toHaveLength(5);
  });

  it("returns entries with name, label, cost, and description", () => {
    for (const entry of listPresets()) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("label");
      expect(entry).toHaveProperty("cost");
      expect(entry).toHaveProperty("description");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.cost).toBe("string");
      expect(typeof entry.description).toBe("string");
    }
  });

  it("contains all preset names", () => {
    const names = listPresets().map((e) => e.name);
    for (const expected of ALL_PRESET_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it("cost field matches estimatedMonthlyCost from SYSTEM_PRESETS", () => {
    for (const entry of listPresets()) {
      const preset = SYSTEM_PRESETS[entry.name as PresetName];
      expect(entry.cost).toBe(preset.estimatedMonthlyCost);
    }
  });

  it("returns a new array on each call (not a shared reference)", () => {
    const a = listPresets();
    const b = listPresets();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_MODEL_OPTIONS
// ---------------------------------------------------------------------------
describe("PROVIDER_MODEL_OPTIONS", () => {
  it("contains entries for multiple providers", () => {
    const providers = Object.keys(PROVIDER_MODEL_OPTIONS);
    expect(providers.length).toBeGreaterThanOrEqual(5);
  });

  it("each provider has at least one model option", () => {
    for (const [provider, options] of Object.entries(PROVIDER_MODEL_OPTIONS)) {
      expect(options.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every model option has required fields with valid types", () => {
    for (const [, options] of Object.entries(PROVIDER_MODEL_OPTIONS)) {
      for (const opt of options) {
        expect(typeof opt.model).toBe("string");
        expect(opt.model.length).toBeGreaterThan(0);
        expect(typeof opt.label).toBe("string");
        expect(opt.label.length).toBeGreaterThan(0);
        expect(["budget", "standard", "premium"]).toContain(opt.tier);
        expect(typeof opt.inputPer1M).toBe("number");
        expect(opt.inputPer1M).toBeGreaterThanOrEqual(0);
        expect(typeof opt.outputPer1M).toBe("number");
        expect(opt.outputPer1M).toBeGreaterThanOrEqual(0);
        expect(typeof opt.contextWindow).toBe("string");
        expect(opt.contextWindow.length).toBeGreaterThan(0);
        expect(typeof opt.notes).toBe("string");
      }
    }
  });

  it("output pricing is greater than or equal to input pricing for each model", () => {
    for (const [, options] of Object.entries(PROVIDER_MODEL_OPTIONS)) {
      for (const opt of options) {
        expect(opt.outputPer1M).toBeGreaterThanOrEqual(opt.inputPer1M);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getProviderModels()
// ---------------------------------------------------------------------------
describe("getProviderModels", () => {
  it("returns models for a known provider", () => {
    const claudeModels = getProviderModels("claude");
    expect(claudeModels.length).toBeGreaterThanOrEqual(1);
    expect(claudeModels[0]).toHaveProperty("model");
    expect(claudeModels[0]).toHaveProperty("tier");
  });

  it("returns the same array reference as PROVIDER_MODEL_OPTIONS for a known provider", () => {
    expect(getProviderModels("openai")).toBe(PROVIDER_MODEL_OPTIONS["openai"]);
  });

  it("returns an empty array for an unknown provider", () => {
    expect(getProviderModels("nonexistent-provider")).toEqual([]);
    expect(getProviderModels("")).toEqual([]);
  });

  it.each(Object.keys(PROVIDER_MODEL_OPTIONS))("returns non-empty array for provider '%s'", (provider) => {
    expect(getProviderModels(provider).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Data integrity: provider chains reference real providers in providerModels
// ---------------------------------------------------------------------------
describe("data integrity", () => {
  it("every provider in providerChain has a corresponding entry in providerModels", () => {
    for (const preset of Object.values(SYSTEM_PRESETS)) {
      const chainProviders = preset.providerChain.split(",");
      for (const provider of chainProviders) {
        expect(preset.providerModels).toHaveProperty(
          provider,
          expect.any(String),
        );
      }
    }
  });

  it("delegation tiers reference providers that are available in providerModels or are ollama (local)", () => {
    for (const preset of Object.values(SYSTEM_PRESETS)) {
      const tiers = [
        preset.delegationTierLocal,
        preset.delegationTierCheap,
        preset.delegationTierStandard,
        preset.delegationTierPremium,
      ];
      for (const tier of tiers) {
        const [provider] = tier.split(":");
        // Provider must be in providerModels OR be 'ollama' (always available locally)
        const isKnown =
          provider in preset.providerModels || provider === "ollama";
        expect(isKnown).toBe(true);
      }
    }
  });

  it("embeddingBaseUrl is only set when embeddingProvider is gemini", () => {
    for (const preset of Object.values(SYSTEM_PRESETS)) {
      if (preset.embeddingBaseUrl) {
        expect(preset.embeddingProvider).toBe("gemini");
      }
    }
  });
});
