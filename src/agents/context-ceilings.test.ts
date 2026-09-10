import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureContextCeilingStore, recordContextCeiling, effectiveContextWindow, readContextCeilings,
  CONTEXT_CEILING_MIN_TOKENS, CONTEXT_CEILING_SHRINK,
} from "./context-ceilings.js";

describe("learned context ceilings (#37)", () => {
  let store: string;
  beforeEach(() => {
    store = join(mkdtempSync(join(tmpdir(), "ceilings-")), "context-ceilings.json");
    configureContextCeilingStore(store);
  });

  it("a hung 57k turn lowers the planning window below the declared 128k, and only ever downwards", () => {
    expect(effectiveContextWindow("opencode (zen/go)", 128_000)).toEqual({ window: 128_000 });
    expect(recordContextCeiling("opencode (zen/go)", 57_000, 1_000)).toBe(Math.floor(57_000 * CONTEXT_CEILING_SHRINK));
    expect(effectiveContextWindow("OpenCode (zen/go)", 128_000)).toEqual({ window: 45_600, learned: 45_600 });
    // a later, larger hang does not raise the ceiling back up
    expect(recordContextCeiling("opencode (zen/go)", 70_000)).toBeUndefined();
    expect(effectiveContextWindow("opencode (zen/go)", 128_000).window).toBe(45_600);
    // a smaller hang lowers it further, never under the minimum
    expect(recordContextCeiling("opencode (zen/go)", 9_000)).toBe(CONTEXT_CEILING_MIN_TOKENS);
    // a declared window already below the ceiling stays as declared
    expect(effectiveContextWindow("opencode (zen/go)", 4_096)).toEqual({ window: 4_096 });
  });

  it("persists beside provider health and is read back after a restart (store re-configured)", () => {
    recordContextCeiling("opencode", 50_000, 5);
    expect(existsSync(store)).toBe(true);
    expect(JSON.parse(readFileSync(store, "utf8"))["opencode"]).toMatchObject({ ceiling: 40_000, observedTokens: 50_000, learnedAt: 5 });
    configureContextCeilingStore(store); // simulates a fresh process
    expect(effectiveContextWindow("opencode", 128_000)).toEqual({ window: 40_000, learned: 40_000 });
    expect(readContextCeilings(store)["opencode"]?.ceiling).toBe(40_000);
  });

  it("an empty observation records nothing", () => {
    expect(recordContextCeiling("x", 0)).toBeUndefined();
    expect(recordContextCeiling("x", Number.NaN)).toBeUndefined();
    expect(effectiveContextWindow("x", 100)).toEqual({ window: 100 });
  });
});
