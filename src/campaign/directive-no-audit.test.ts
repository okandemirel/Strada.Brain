import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Measured live 2026-09-03 23:30: told to "report the suite's actual pass/fail
 * counts", the sprint answered with a JSON inventory — module counts, prefab
 * counts, a scene list — and changed nothing. Both delivery directives must
 * name the verb and forbid the audit escape.
 */
describe("delivery directives", () => {
  const source = readFileSync(new URL("./campaign-manager.ts", import.meta.url), "utf8");

  it("forbid an inventory in the test-verdict directive", () => {
    const start = source.indexOf("DELIVERY VERIFICATION REQUIRED");
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start, start + 1200)).toContain("DO NOT AUDIT");
  });

  it("forbid an inventory in the structural directive", () => {
    const start = source.indexOf("Fix the game, not the report");
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start, start + 600)).toContain("DO NOT AUDIT");
  });
});
