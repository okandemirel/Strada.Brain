import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillEnvInjector } from "./skill-env-injector.js";

describe("SkillEnvInjector", () => {
  let injector: SkillEnvInjector;

  // Save and restore env keys we touch so tests don't leak
  const testKeys = [
    "SKILL_INJ_A",
    "SKILL_INJ_B",
    "SKILL_INJ_EXISTING",
    "SKILL_INJ_X",
    "SKILL_INJ_Y",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    injector = new SkillEnvInjector();
    for (const key of testKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of testKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // -------------------------------------------------------------------------
  // inject
  // -------------------------------------------------------------------------

  it("sets environment variables on inject", () => {
    injector.inject("test-skill", { SKILL_INJ_A: "alpha", SKILL_INJ_B: "beta" });

    expect(process.env["SKILL_INJ_A"]).toBe("alpha");
    expect(process.env["SKILL_INJ_B"]).toBe("beta");
  });

  it("overwrites existing env values", () => {
    process.env["SKILL_INJ_EXISTING"] = "original";

    injector.inject("test-skill", { SKILL_INJ_EXISTING: "overwritten" });

    expect(process.env["SKILL_INJ_EXISTING"]).toBe("overwritten");
  });

  // -------------------------------------------------------------------------
  // restore
  // -------------------------------------------------------------------------

  it("restores previously undefined keys by deleting them", () => {
    delete process.env["SKILL_INJ_A"];

    injector.inject("test-skill", { SKILL_INJ_A: "injected" });
    expect(process.env["SKILL_INJ_A"]).toBe("injected");

    injector.restore("test-skill");
    expect(process.env["SKILL_INJ_A"]).toBeUndefined();
  });

  it("restores previously set keys to their original value", () => {
    process.env["SKILL_INJ_EXISTING"] = "original";

    injector.inject("test-skill", { SKILL_INJ_EXISTING: "overwritten" });
    expect(process.env["SKILL_INJ_EXISTING"]).toBe("overwritten");

    injector.restore("test-skill");
    expect(process.env["SKILL_INJ_EXISTING"]).toBe("original");
  });

  it("is a no-op when restoring a skill that was never injected", () => {
    // Should not throw
    injector.restore("nonexistent-skill");
  });

  it("clears the snapshot after restore", () => {
    injector.inject("test-skill", { SKILL_INJ_A: "val" });
    expect(injector.hasSnapshot("test-skill")).toBe(true);

    injector.restore("test-skill");
    expect(injector.hasSnapshot("test-skill")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Multiple skills
  // -------------------------------------------------------------------------

  it("tracks snapshots independently per skill", () => {
    delete process.env["SKILL_INJ_X"];
    delete process.env["SKILL_INJ_Y"];

    injector.inject("skill-a", { SKILL_INJ_X: "from-a" });
    injector.inject("skill-b", { SKILL_INJ_Y: "from-b" });

    expect(process.env["SKILL_INJ_X"]).toBe("from-a");
    expect(process.env["SKILL_INJ_Y"]).toBe("from-b");

    // Restore only skill-a
    injector.restore("skill-a");
    expect(process.env["SKILL_INJ_X"]).toBeUndefined();
    expect(process.env["SKILL_INJ_Y"]).toBe("from-b"); // skill-b still active

    // Restore skill-b
    injector.restore("skill-b");
    expect(process.env["SKILL_INJ_Y"]).toBeUndefined();
  });
});
