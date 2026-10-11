/**
 * The scope gate's shared contracts (GDD-drift plan W00).
 *
 * Every later item reads these: the flag that decides whether the gate acts,
 * the names the system gives its own acceptance tests, and the closed sets a
 * row's kind and status come from. They are pinned here so two items built in
 * parallel cannot each mean something different by them.
 */

import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TEST_CATEGORY,
  ACCEPTANCE_TEST_NAMESPACE,
  DEFAULT_SCOPE_GATE_MODE,
  REQUIREMENT_KINDS,
  REQUIREMENT_STATUSES,
  SCOPE_GATE_ENV,
  SCOPE_GATE_MODES,
  isAcceptanceTestName,
  parseScopeGateMode,
} from "./scope-types.js";

describe("the scope gate flag", () => {
  it("has three modes, and is off unless a person turns it on", () => {
    expect([...SCOPE_GATE_MODES]).toEqual(["off", "shadow", "on"]);
    // Off is today's behaviour: W00 adds the flag, nothing reads it yet.
    expect(DEFAULT_SCOPE_GATE_MODE).toBe("off");
    expect(SCOPE_GATE_ENV).toBe("CAMPAIGN_SCOPE_GATE");
  });

  it("reads exactly off, shadow and on (any case, surrounding space ignored)", () => {
    expect(parseScopeGateMode("off")).toEqual({ mode: "off" });
    expect(parseScopeGateMode("shadow")).toEqual({ mode: "shadow" });
    expect(parseScopeGateMode("on")).toEqual({ mode: "on" });
    expect(parseScopeGateMode(" Shadow \n")).toEqual({ mode: "shadow" });
    expect(parseScopeGateMode("ON")).toEqual({ mode: "on" });
  });

  it("unset or empty is the default, without a warning", () => {
    expect(parseScopeGateMode(undefined)).toEqual({ mode: "off" });
    expect(parseScopeGateMode("")).toEqual({ mode: "off" });
    expect(parseScopeGateMode("   ")).toEqual({ mode: "off" });
  });

  it("an unreadable value is off, with a warning that names the variable and the value", () => {
    // A boolean spelling must not switch enforcement on: "on" is a mode here,
    // "true" and "1" are not.
    for (const raw of ["true", "1", "yes", "enabled", "shdow", "on;", "shadow,on"]) {
      const parsed = parseScopeGateMode(raw);
      expect(parsed.mode, raw).toBe("off");
      expect(parsed.warning, raw).toContain("CAMPAIGN_SCOPE_GATE");
      expect(parsed.warning, raw).toContain(JSON.stringify(raw));
      expect(parsed.warning, raw).toMatch(/off/);
    }
  });

  it("a long unreadable value is quoted only in part", () => {
    const parsed = parseScopeGateMode("x".repeat(500));
    expect(parsed.mode).toBe("off");
    expect(parsed.warning!.length).toBeLessThan(200);
  });
});

describe("the system's own acceptance tests", () => {
  it("live under one namespace and one category", () => {
    expect(ACCEPTANCE_TEST_NAMESPACE).toBe("Strada.Acceptance");
    expect(ACCEPTANCE_TEST_CATEGORY).toBe("StradaAcceptance");
  });

  it("a full NUnit name inside the namespace is one of them; anything else is not", () => {
    expect(isAcceptanceTestName("Strada.Acceptance.M2.Acceptance_M2.R01_a1b2c3")).toBe(true);
    expect(isAcceptanceTestName("  Strada.Acceptance.M2.Acceptance_M2.R01_a1b2c3 ")).toBe(true);
    // A worker's own test, a lookalike namespace and a bare prefix are not.
    expect(isAcceptanceTestName("Game.Tests.PlayerTests.Jump")).toBe(false);
    expect(isAcceptanceTestName("Strada.AcceptanceExtra.M2.T")).toBe(false);
    expect(isAcceptanceTestName("Strada.Acceptance")).toBe(false);
    expect(isAcceptanceTestName("Strada.Acceptance.")).toBe(false);
    expect(isAcceptanceTestName("MyGame.Strada.Acceptance.M2.T")).toBe(false);
  });
});

describe("row kinds and statuses", () => {
  it("are the closed sets the plan names", () => {
    expect([...REQUIREMENT_KINDS]).toEqual([
      "rule",
      "constant",
      "range",
      "input",
      "flow",
      "screen",
      "claim",
      "aspiration",
      "judgement",
    ]);
    expect([...REQUIREMENT_STATUSES]).toEqual([
      "open",
      "passing",
      "failing",
      "check-fault",
      "unmeasured",
      "excluded",
      "waived",
    ]);
  });
});
