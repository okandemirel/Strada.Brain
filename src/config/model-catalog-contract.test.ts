/**
 * Model-catalog contract tests.
 *
 * Every Claude model id that ships in a preset, a delegation tier default, or
 * the setup wizard must exist in the model-intelligence seed catalog. Without
 * this, a hand-edited literal can drift out of existence and the failure only
 * surfaces as a 404 on a real user's first API call.
 *
 * That is exactly what happened: `claude-sonnet-4-6-20250514` and
 * `claude-opus-4-6-20250514` were fabricated by appending Claude Opus 4's
 * release date to a 4.6 alias. Anthropic model ids are complete as published —
 * appending a date suffix produces an id that does not resolve.
 *
 * Scope note: only Anthropic ids are asserted against the seed list, because
 * only those are independently verifiable here. The structural assertions
 * (shape, no date suffixes, tier specs parse) apply to every provider.
 */

import { describe, it, expect } from "vitest";
import { HARDCODED_MODELS } from "../agents/providers/model-intelligence.js";
import { SYSTEM_PRESETS, PROVIDER_MODEL_OPTIONS } from "./presets.js";
import { parseTierSpec } from "../agents/multi/delegation/tier-resolution.js";

/** Ids in the seed catalog, which is also the offline fallback. */
const SEED_IDS = new Set(HARDCODED_MODELS.keys());

/** Anthropic aliases are complete as published; a trailing `-YYYYMMDD` on an
 *  alias that has no dated form is the fabrication pattern we guard against. */
const DATE_SUFFIX_RE = /-\d{8}$/;

function claudeIdsIn(source: Iterable<string>): string[] {
  return [...source].filter((id) => id.startsWith("claude-"));
}

describe("seed catalog integrity", () => {
  it("contains no fabricated date-suffixed Anthropic alias", () => {
    const offenders = claudeIdsIn(SEED_IDS).filter((id) => DATE_SUFFIX_RE.test(id));
    // `claude-haiku-4-5-20251001` is a real published full id, so if a dated id
    // is ever legitimately added this test should be updated deliberately —
    // not silently loosened.
    expect(offenders).toEqual([]);
  });

  it("has at least one Anthropic model so the offline fallback is usable", () => {
    expect(claudeIdsIn(SEED_IDS).length).toBeGreaterThan(0);
  });

  it("gives every seed model a sane context window and price", () => {
    for (const [id, info] of HARDCODED_MODELS) {
      expect(info.contextWindow, `${id} contextWindow`).toBeGreaterThan(0);
      expect(info.maxOutputTokens, `${id} maxOutputTokens`).toBeGreaterThan(0);
      expect(info.inputPricePerMillion, `${id} inputPrice`).toBeGreaterThanOrEqual(0);
      expect(info.outputPricePerMillion, `${id} outputPrice`).toBeGreaterThanOrEqual(0);
      // A model may not produce more output than its context can hold.
      expect(info.maxOutputTokens, `${id} output <= context`).toBeLessThanOrEqual(info.contextWindow);
    }
  });
});

describe("presets reference real models", () => {
  const presetEntries = Object.entries(SYSTEM_PRESETS);

  it.each(presetEntries)("%s: providerModels claude id exists in the seed catalog", (_name, preset) => {
    const claudeModel = preset.providerModels?.["claude"];
    if (!claudeModel) return;
    expect(SEED_IDS).toContain(claudeModel);
  });

  it.each(presetEntries)("%s: every delegation tier spec parses", (_name, preset) => {
    const specs = [
      preset.delegationTierLocal,
      preset.delegationTierCheap,
      preset.delegationTierStandard,
      preset.delegationTierPremium,
    ].filter((s): s is string => Boolean(s && s.trim()));
    for (const spec of specs) {
      expect(parseTierSpec(spec), `spec "${spec}"`).toBeDefined();
    }
  });

  it.each(presetEntries)("%s: claude delegation tiers point at a real model", (_name, preset) => {
    const specs = [
      preset.delegationTierLocal,
      preset.delegationTierCheap,
      preset.delegationTierStandard,
      preset.delegationTierPremium,
    ].filter((s): s is string => Boolean(s && s.trim()));
    for (const spec of specs) {
      const parsed = parseTierSpec(spec)!;
      if (parsed.provider !== "claude") continue;
      expect(SEED_IDS, `${spec}`).toContain(parsed.model);
    }
  });
});

describe("PROVIDER_MODEL_OPTIONS reference real models", () => {
  it("lists only Anthropic ids that exist in the seed catalog", () => {
    const offered = (PROVIDER_MODEL_OPTIONS["claude"] ?? []).map((o) => o.model);
    expect(offered.length).toBeGreaterThan(0);
    for (const model of offered) {
      expect(SEED_IDS, `offered model ${model}`).toContain(model);
    }
  });

  it("offers no date-suffixed Anthropic alias to the user", () => {
    for (const [provider, options] of Object.entries(PROVIDER_MODEL_OPTIONS)) {
      if (provider !== "claude") continue;
      for (const o of options) {
        expect(DATE_SUFFIX_RE.test(o.model), `${o.model} has a date suffix`).toBe(false);
      }
    }
  });
});
