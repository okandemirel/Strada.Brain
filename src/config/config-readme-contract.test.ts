import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";

/**
 * src/config/README.md documents the schema contract ("default X, range A..B").
 * Audited 2026-09-02: four rows contradicted the schema — an operator who set
 * the documented PROVIDER_MAX_CONCURRENT_REQUESTS=32 died at boot with
 * "Too big: expected number to be <=20", and MULTI_AGENT_ENABLED /
 * TASK_DELEGATION_ENABLED were documented as default true while prefaulting
 * to false. These tests read the real README and the real schema, so the
 * doc cannot drift from the code without a test naming the row.
 */
const readme = readFileSync(join(import.meta.dirname, "README.md"), "utf8");
const row = (envVar: string): string => {
  const line = readme.split("\n").find((l) => l.includes(`\`${envVar}\``) && l.startsWith("|"));
  expect(line, `README table row mentioning ${envVar}`).toBeDefined();
  return line as string;
};

const baseEnv = {
  UNITY_PROJECT_PATH: process.cwd(),
  ANTHROPIC_API_KEY: "sk-test-key-123",
};

describe("src/config/README.md matches the schema it documents", () => {
  it("PROVIDER_MAX_CONCURRENT_REQUESTS: documented range is the schema's range", () => {
    const line = row("PROVIDER_MAX_CONCURRENT_REQUESTS");
    const match = /range (\d+)\.\.(\d+)/.exec(line);
    expect(match, "README row states a range").not.toBeNull();
    const [, min, max] = match as RegExpExecArray;
    // The real boot path: loadConfig throws "Invalid configuration" outside the range.
    const okAt = (value: string): boolean => {
      try {
        return loadConfig({ ...baseEnv, PROVIDER_MAX_CONCURRENT_REQUESTS: value }).providerMaxConcurrentRequests === Number(value);
      } catch {
        return false;
      }
    };
    expect(okAt(min)).toBe(true);
    expect(okAt(max)).toBe(true);
    expect(okAt(String(Number(max) + 1))).toBe(false);
    expect(okAt(String(Number(min) - 1))).toBe(false);
  });

  it("MULTI_AGENT_ENABLED / TASK_DELEGATION_ENABLED: documented default is the schema prefault", () => {
    const config = loadConfig({ ...baseEnv });
    expect(row("MULTI_AGENT_ENABLED")).toMatch(
      new RegExp(`\`MULTI_AGENT_ENABLED\` \\(default ${config.agent.enabled}[;)]`),
    );
    expect(row("TASK_DELEGATION_ENABLED")).toMatch(
      new RegExp(`\`TASK_DELEGATION_ENABLED\` \\(default ${config.delegation.enabled}[;)]`),
    );
  });

  it("WEBSOCKET_DASHBOARD_PORT: documented default is the schema prefault (and not the dashboard's port)", () => {
    const config = loadConfig({ ...baseEnv });
    expect(row("WEBSOCKET_DASHBOARD_PORT")).toMatch(
      new RegExp(`\`WEBSOCKET_DASHBOARD_PORT\` \\(default ${config.websocketDashboard.port}[;)]`),
    );
    expect(config.websocketDashboard.port).not.toBe(config.dashboard.port);
  });

  it("CAMPAIGN_SCOPE_GATE / CAMPAIGN_ACCEPTANCE_WRITER: documented defaults are the schema's", () => {
    const config = loadConfig({ ...baseEnv });
    expect(row("CAMPAIGN_SCOPE_GATE")).toMatch(
      new RegExp(`\`CAMPAIGN_SCOPE_GATE\` \\(default ${config.campaign.scopeGate}[;)]`),
    );
    // The documented modes are the ones the parser takes, and an unreadable
    // value is documented as what it does.
    for (const mode of ["off", "shadow", "on"]) {
      expect(loadConfig({ ...baseEnv, CAMPAIGN_SCOPE_GATE: mode }).campaign.scopeGate).toBe(mode);
      expect(row("CAMPAIGN_SCOPE_GATE")).toContain(`\`${mode}\``);
    }
    expect(row("CAMPAIGN_SCOPE_GATE")).toMatch(/any other value reads as `off`/);
    expect(config.campaign.acceptanceWriter).toBeUndefined();
    expect(row("CAMPAIGN_ACCEPTANCE_WRITER")).toMatch(/`CAMPAIGN_ACCEPTANCE_WRITER` \(default auto[;)]/);
  });

  it("CAMPAIGN_MAX_REQUIREMENT_ROWS: documented default and range are the schema's", () => {
    const match = /`CAMPAIGN_MAX_REQUIREMENT_ROWS` \(default (\d+), range (\d+)\.\.(\d+)[;)]/.exec(
      row("CAMPAIGN_MAX_REQUIREMENT_ROWS"),
    );
    expect(match, "README row states a default and a range").not.toBeNull();
    const [, def, min, max] = match as RegExpExecArray;
    expect(loadConfig({ ...baseEnv }).campaign.maxRequirementRows).toBe(Number(def));
    const okAt = (value: string): boolean => {
      try {
        return loadConfig({ ...baseEnv, CAMPAIGN_MAX_REQUIREMENT_ROWS: value }).campaign.maxRequirementRows === Number(value);
      } catch {
        return false;
      }
    };
    expect(okAt(min)).toBe(true);
    expect(okAt(max)).toBe(true);
    expect(okAt(String(Number(max) + 1))).toBe(false);
    expect(okAt(String(Number(min) - 1))).toBe(false);
  });

  it("Validation Helpers section does not present uncalled helpers as the boot gate", () => {
    // hasRequiredApiKeys / checkChannelConfig have no callers; the enforced
    // credential gate is the schema superRefine inside validateConfig.
    const section = readme.slice(readme.indexOf("### Validation Helpers"));
    expect(section).toMatch(/not (called|invoked) by `loadConfig`/);
  });
});
