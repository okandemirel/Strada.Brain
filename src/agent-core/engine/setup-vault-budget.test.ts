import { describe, it, expect } from "vitest";
import { vaultContextBudgetTokens } from "./setup.js";

describe("vaultContextBudgetTokens (measured 2026-09-09: 4 000 tokens = 15 724 chars of every worker turn)", () => {
  it("reads VAULT_CONTEXT_BUDGET_TOKENS, floors at 500, and defaults to 4 000", () => {
    expect(vaultContextBudgetTokens({ VAULT_CONTEXT_BUDGET_TOKENS: "1500" } as NodeJS.ProcessEnv)).toBe(1500);
    expect(vaultContextBudgetTokens({ VAULT_CONTEXT_BUDGET_TOKENS: "10" } as NodeJS.ProcessEnv)).toBe(4000);
    expect(vaultContextBudgetTokens({ VAULT_CONTEXT_BUDGET_TOKENS: "abc" } as NodeJS.ProcessEnv)).toBe(4000);
    expect(vaultContextBudgetTokens({} as NodeJS.ProcessEnv)).toBe(4000);
  });
});
