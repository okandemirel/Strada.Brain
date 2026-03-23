import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkGates } from "./skill-gating.js";
import type { SkillRequirements } from "./types.js";

// ---------------------------------------------------------------------------
// Mock execFileNoThrow so tests don't depend on real binaries
// ---------------------------------------------------------------------------

const mockExecFileNoThrow = vi.fn();

vi.mock("../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

beforeEach(() => {
  mockExecFileNoThrow.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkGates", () => {
  // -------------------------------------------------------------------------
  // No requirements
  // -------------------------------------------------------------------------

  it("returns passed when requirements are undefined", async () => {
    const result = await checkGates(undefined);
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("returns passed when requirements object is empty", async () => {
    const result = await checkGates({});
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Binary checks
  // -------------------------------------------------------------------------

  it("passes when all required binaries are found", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "/usr/bin/node", stderr: "" });

    const requires: SkillRequirements = { bins: ["node"] };
    const result = await checkGates(requires);

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails with reason when a binary is not found", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });

    const requires: SkillRequirements = { bins: ["nonexistent-tool"] };
    const result = await checkGates(requires);

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("nonexistent-tool");
  });

  it("reports multiple missing binaries", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });

    const requires: SkillRequirements = { bins: ["missing-a", "missing-b"] };
    const result = await checkGates(requires);

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons.some((r) => r.includes("missing-a"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("missing-b"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Environment variable checks
  // -------------------------------------------------------------------------

  it("passes when required env vars are set", async () => {
    process.env["SKILL_TEST_VAR"] = "hello";
    try {
      const requires: SkillRequirements = { env: ["SKILL_TEST_VAR"] };
      const result = await checkGates(requires);
      expect(result.passed).toBe(true);
      expect(result.reasons).toEqual([]);
    } finally {
      delete process.env["SKILL_TEST_VAR"];
    }
  });

  it("fails when a required env var is missing", async () => {
    delete process.env["SKILL_MISSING_VAR"];

    const requires: SkillRequirements = { env: ["SKILL_MISSING_VAR"] };
    const result = await checkGates(requires);

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("SKILL_MISSING_VAR");
  });

  it("fails when a required env var is empty string", async () => {
    process.env["SKILL_EMPTY_VAR"] = "";
    try {
      const requires: SkillRequirements = { env: ["SKILL_EMPTY_VAR"] };
      const result = await checkGates(requires);
      expect(result.passed).toBe(false);
      expect(result.reasons[0]).toContain("SKILL_EMPTY_VAR");
    } finally {
      delete process.env["SKILL_EMPTY_VAR"];
    }
  });

  // -------------------------------------------------------------------------
  // Config checks (dot-path traversal)
  // -------------------------------------------------------------------------

  it("passes when required config keys exist", async () => {
    const config = { llm: { apiKey: "sk-123", provider: "openai" } };
    const requires: SkillRequirements = { config: ["llm.apiKey"] };
    const result = await checkGates(requires, config);

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when a required config key is missing", async () => {
    const config = { llm: { provider: "openai" } };
    const requires: SkillRequirements = { config: ["llm.apiKey"] };
    const result = await checkGates(requires, config);

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("llm.apiKey");
  });

  it("fails when config object is undefined", async () => {
    const requires: SkillRequirements = { config: ["llm.apiKey"] };
    const result = await checkGates(requires);

    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toContain("llm.apiKey");
  });

  it("handles deeply nested config paths", async () => {
    const config = { a: { b: { c: { d: "found" } } } };
    const requires: SkillRequirements = { config: ["a.b.c.d"] };
    const result = await checkGates(requires, config);

    expect(result.passed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Combined failures
  // -------------------------------------------------------------------------

  it("lists all failures when multiple gate types fail", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
    delete process.env["SKILL_COMBO_VAR"];

    const requires: SkillRequirements = {
      bins: ["missing-bin"],
      env: ["SKILL_COMBO_VAR"],
      config: ["missing.key"],
    };
    const result = await checkGates(requires, {});

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons.some((r) => r.includes("missing-bin"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("SKILL_COMBO_VAR"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("missing.key"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // All requirements met
  // -------------------------------------------------------------------------

  it("passes when all requirement types are satisfied", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "/usr/bin/node", stderr: "" });
    process.env["SKILL_ALL_MET"] = "value";

    try {
      const config = { llm: { apiKey: "sk-123" } };
      const requires: SkillRequirements = {
        bins: ["node"],
        env: ["SKILL_ALL_MET"],
        config: ["llm.apiKey"],
      };
      const result = await checkGates(requires, config);

      expect(result.passed).toBe(true);
      expect(result.reasons).toEqual([]);
    } finally {
      delete process.env["SKILL_ALL_MET"];
    }
  });
});
