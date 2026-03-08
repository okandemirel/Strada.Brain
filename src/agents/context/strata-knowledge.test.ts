import { describe, it, expect } from "vitest";
import { buildCapabilityManifest, buildIdentitySection } from "./strata-knowledge.js";
import type { IdentityState } from "../../identity/identity-state.js";

describe("buildCapabilityManifest", () => {
  it("returns a non-empty string", () => {
    const result = buildCapabilityManifest();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("contains Goal Decomposition section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/goal decomposition/i);
  });

  it("contains Learning Pipeline section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/learning pipeline/i);
  });

  it("contains Tool Chain Synthesis section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/tool chain synthesis/i);
  });

  it("contains Memory section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/memory/i);
  });

  it("contains Introspection section", () => {
    const result = buildCapabilityManifest();
    expect(result).toMatch(/introspection/i);
  });

  it("does NOT contain hardcoded tool names that change at runtime", () => {
    const result = buildCapabilityManifest();
    // These are dynamic tool names that should not be in the manifest
    expect(result).not.toMatch(/\bfile_read\b/);
    expect(result).not.toMatch(/\bgrep_search\b/);
    expect(result).not.toMatch(/\bfile_write\b/);
    expect(result).not.toMatch(/\bdotnet_build\b/);
  });

  it("has a length between 500 and 3000 characters", () => {
    const result = buildCapabilityManifest();
    expect(result.length).toBeGreaterThanOrEqual(500);
    expect(result.length).toBeLessThanOrEqual(3000);
  });
});

function makeSampleState(overrides?: Partial<IdentityState>): IdentityState {
  return {
    agentUuid: "550e8400-e29b-41d4-a716-446655440000",
    agentName: "Strata Brain",
    firstBootTs: 1709856000000, // 2024-03-08
    bootCount: 5,
    cumulativeUptimeMs: 5580000, // 1h33m
    lastActivityTs: 1709942400000,
    totalMessages: 42,
    totalTasks: 10,
    projectContext: "/projects/MyGame",
    cleanShutdown: true,
    ...overrides,
  };
}

describe("buildIdentitySection", () => {
  it("returns expected format with all fields", () => {
    const state = makeSampleState();
    const result = buildIdentitySection(state);

    expect(result).toContain("## Agent Identity");
    expect(result).toContain("**Name:** Strata Brain");
    expect(result).toContain("**Boot #:** 5");
    expect(result).toContain("**Uptime (total):**");
    expect(result).toContain("**Created:** 2024-03-08");
    expect(result).toContain("**Project:** /projects/MyGame");
    expect(result).toContain("5 sessions");
  });

  it("omits Project line when projectContext is empty string", () => {
    const state = makeSampleState({ projectContext: "" });
    const result = buildIdentitySection(state);

    expect(result).not.toContain("**Project:**");
  });

  it("formats 0ms uptime as '0 minutes'", () => {
    const state = makeSampleState({ cumulativeUptimeMs: 0 });
    const result = buildIdentitySection(state);

    expect(result).toContain("0 minutes");
  });

  it("formats 3600000ms uptime as '1 hour 0 minutes'", () => {
    const state = makeSampleState({ cumulativeUptimeMs: 3600000 });
    const result = buildIdentitySection(state);

    expect(result).toContain("1 hour 0 minutes");
  });

  it("formats 5580000ms uptime as '1 hour 33 minutes'", () => {
    const state = makeSampleState({ cumulativeUptimeMs: 5580000 });
    const result = buildIdentitySection(state);

    expect(result).toContain("1 hour 33 minutes");
  });
});
