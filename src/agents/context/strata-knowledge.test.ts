import { describe, it, expect } from "vitest";
import { buildCapabilityManifest } from "./strata-knowledge.js";

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
