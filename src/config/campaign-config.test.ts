/**
 * The campaign scope gate's settings (GDD-drift plan W00).
 *
 * CAMPAIGN_SCOPE_GATE decides whether a milestone's green has to come from
 * its own GDD rows passing system-owned checks. Its default is off, which is
 * today's behaviour; an unreadable value must never switch enforcement on and
 * must not stop the daemon from booting either, so it reads as off and the
 * boot says which variable it ignored.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  UNITY_PROJECT_PATH: process.cwd(),
  ANTHROPIC_API_KEY: "sk-test-key-123",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("campaign scope gate settings", () => {
  it("defaults: gate off, writer auto, 400 requirement rows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = loadConfig({ ...baseEnv });
    expect(config.campaign.scopeGate).toBe("off");
    expect(config.campaign.acceptanceWriter).toBeUndefined();
    expect(config.campaign.maxRequirementRows).toBe(400);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("CAMPAIGN_SCOPE_GATE");
  });

  it("CAMPAIGN_SCOPE_GATE takes off, shadow and on", () => {
    for (const mode of ["off", "shadow", "on"] as const) {
      expect(loadConfig({ ...baseEnv, CAMPAIGN_SCOPE_GATE: mode }).campaign.scopeGate).toBe(mode);
    }
    expect(loadConfig({ ...baseEnv, CAMPAIGN_SCOPE_GATE: " Shadow " }).campaign.scopeGate).toBe("shadow");
    expect(loadConfig({ ...baseEnv, CAMPAIGN_SCOPE_GATE: "" }).campaign.scopeGate).toBe("off");
  });

  it("an unreadable CAMPAIGN_SCOPE_GATE boots with the gate off and a warning naming it", () => {
    for (const raw of ["true", "1", "enforce"]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = loadConfig({ ...baseEnv, CAMPAIGN_SCOPE_GATE: raw });
      expect(config.campaign.scopeGate, raw).toBe("off");
      const said = warn.mock.calls.flat().join("\n");
      expect(said, raw).toContain("CAMPAIGN_SCOPE_GATE");
      expect(said, raw).toContain(JSON.stringify(raw));
      warn.mockRestore();
    }
  });

  it("CAMPAIGN_ACCEPTANCE_WRITER reads provider[:model]; auto or empty means pick at run time", () => {
    expect(loadConfig({ ...baseEnv, CAMPAIGN_ACCEPTANCE_WRITER: "opencode2" }).campaign.acceptanceWriter).toEqual({
      provider: "opencode2",
    });
    // A model id may carry its own colons and slashes; only the first colon splits.
    expect(
      loadConfig({ ...baseEnv, CAMPAIGN_ACCEPTANCE_WRITER: " OpenRouter:vendor/model-x:free " }).campaign.acceptanceWriter,
    ).toEqual({ provider: "openrouter", model: "vendor/model-x:free" });
    expect(loadConfig({ ...baseEnv, CAMPAIGN_ACCEPTANCE_WRITER: "auto" }).campaign.acceptanceWriter).toBeUndefined();
    expect(loadConfig({ ...baseEnv, CAMPAIGN_ACCEPTANCE_WRITER: "" }).campaign.acceptanceWriter).toBeUndefined();
  });

  it("a malformed CAMPAIGN_ACCEPTANCE_WRITER is a config error that names the setting", () => {
    for (const raw of [":model", "open code", "provider:"]) {
      expect(() => loadConfig({ ...baseEnv, CAMPAIGN_ACCEPTANCE_WRITER: raw }), raw).toThrow(/campaignAcceptanceWriter/);
    }
  });

  it("CAMPAIGN_MAX_REQUIREMENT_ROWS is held to 50..2000", () => {
    const at = (value: string) => loadConfig({ ...baseEnv, CAMPAIGN_MAX_REQUIREMENT_ROWS: value }).campaign.maxRequirementRows;
    expect(at("50")).toBe(50);
    expect(at("2000")).toBe(2000);
    expect(() => at("49")).toThrow(/campaignMaxRequirementRows/);
    expect(() => at("2001")).toThrow(/campaignMaxRequirementRows/);
    expect(() => at("many")).toThrow(/campaignMaxRequirementRows/);
  });
});
