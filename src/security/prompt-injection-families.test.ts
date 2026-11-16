import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../agents/providers/provider-registry.js";
import { PROVIDER_MODEL_OPTIONS, SYSTEM_PRESETS } from "../config/presets.js";
import {
  CHAT_TEMPLATE_EXEMPT,
  CHAT_TEMPLATE_FAMILIES,
  sanitizePromptInjection,
} from "./prompt-injection.js";

/**
 * Every model the repository can be configured to call, by id: the registry's
 * default per provider, the setup wizard's model options, and the models the
 * system presets name (a delegation tier reads "provider:model").
 */
function catalogModelIds(): string[] {
  const ids = new Set<string>();
  for (const preset of Object.values(PROVIDER_PRESETS)) ids.add(preset.defaultModel);
  for (const options of Object.values(PROVIDER_MODEL_OPTIONS)) for (const option of options) ids.add(option.model);
  for (const preset of Object.values(SYSTEM_PRESETS)) {
    for (const model of Object.values(preset.providerModels)) ids.add(model);
    for (const tier of [preset.delegationTierLocal, preset.delegationTierCheap, preset.delegationTierStandard, preset.delegationTierPremium]) {
      ids.add(tier.slice(tier.indexOf(":") + 1));
    }
  }
  return [...ids].sort();
}

describe("chat-template families", () => {
  it("gives every catalog model a family row, or a reason it has none", () => {
    // A model added to the catalog whose template has no row here would carry
    // its turns into prompts untouched (#35, #36, #80, #81 each found one more).
    // Add its row to CHAT_TEMPLATE_FAMILIES, or say in CHAT_TEMPLATE_EXEMPT why
    // its provider exposes no text special tokens.
    const ids = catalogModelIds();
    expect(ids.length).toBeGreaterThan(20);
    const unmatched = ids.filter(
      (id) => !CHAT_TEMPLATE_FAMILIES.some((row) => row.models.test(id)) && !CHAT_TEMPLATE_EXEMPT.some((row) => row.models.test(id)),
    );
    expect(unmatched).toEqual([]);
    // An id two rows claim would leave it unclear which template the id uses.
    const ambiguous = ids.filter(
      (id) => [...CHAT_TEMPLATE_FAMILIES, ...CHAT_TEMPLATE_EXEMPT].filter((row) => row.models.test(id)).length > 1,
    );
    expect(ambiguous).toEqual([]);
  });

  it("covers the families the series asked for by name", () => {
    expect(CHAT_TEMPLATE_FAMILIES.map((row) => row.family)).toEqual(
      expect.arrayContaining(["chatml", "kimi", "llama3", "llama4", "harmony", "gemma", "mistral", "phi3", "glm", "deepseek", "minimax"]),
    );
    for (const row of CHAT_TEMPLATE_EXEMPT) expect(row.why.length, row.family).toBeGreaterThan(20);
  });

  // Each opener with each closer of its row, in the token's own case, upper
  // and lower case, and with whitespace on both sides of every token.
  for (const row of CHAT_TEMPLATE_FAMILIES) {
    const closers = [...row.close, ...(row.closeInTurn ?? [])];
    it(`${row.family}: every opener with every closer drops the payload`, () => {
      for (const open of row.open) {
        for (const close of closers) {
          for (const cased of [(t: string) => t, (t: string) => t.toUpperCase(), (t: string) => t.toLowerCase()]) {
            for (const [before, after] of [["", ""], [" \n", "\n "]]) {
              const text = `Context:\n${cased(open)}${before}role\nXPAY${after}${cased(close)}\nEnd.`;
              const cleaned = sanitizePromptInjection(text);
              const label = JSON.stringify(text);
              expect(cleaned, label).not.toContain("XPAY");
              expect(cleaned.toLowerCase(), label).not.toContain(close.normalize("NFKC").toLowerCase());
              expect(cleaned, label).toMatch(/^Context:\n[\s\S]*\nEnd\.$/);
            }
          }
        }
      }
    });

    it(`${row.family}: a turn the next opener ends drops its payload`, () => {
      for (const open of row.open) {
        const next = row.open[(row.open.indexOf(open) + 1) % row.open.length]!;
        const close = closers[0]!;
        const text = `Context:\n${open}XPAY${next}YPAY${close}\nEnd.`;
        const cleaned = sanitizePromptInjection(text);
        expect(cleaned, text).not.toContain("XPAY");
        expect(cleaned, text).not.toContain("YPAY");
      }
    });

    it(`${row.family}: every token alone is filtered, except a closer legitimate text also spells`, () => {
      for (const token of [...row.open, ...row.close, ...row.lone]) {
        expect(sanitizePromptInjection(`before ${token} after`), token).toBe("before [filtered:envelope]  after");
      }
      for (const token of row.closeInTurn ?? []) {
        expect(sanitizePromptInjection(`before ${token} after`), token).toBe(`before ${token} after`);
      }
    });
  }
});
