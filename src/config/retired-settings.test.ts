import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

/**
 * The goal-execution knobs (GOAL_MAX_RETRIES, GOAL_MAX_FAILURES,
 * GOAL_PARALLEL_EXECUTION, GOAL_MAX_PARALLEL, STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES,
 * STRADA_GOAL_MAX_REDECOMPOSITIONS) lost their reader when the GoalExecutor was
 * folded into the supervisor, and STRADA_VAULT_EMBEDDING_FALLBACK never had one.
 * They were still documented, parsed and range-checked, so an operator who set
 * GOAL_MAX_PARALLEL=1 to stop parallel goal execution changed nothing — and one
 * who set it to 0 could not boot at all, over a value nothing reads.
 */
const baseEnv = {
  UNITY_PROJECT_PATH: process.cwd(),
  ANTHROPIC_API_KEY: "sk-test-key-123",
};

const RETIRED = [
  "GOAL_MAX_RETRIES",
  "GOAL_MAX_FAILURES",
  "GOAL_PARALLEL_EXECUTION",
  "GOAL_MAX_PARALLEL",
  "STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES",
  "STRADA_GOAL_MAX_REDECOMPOSITIONS",
  "STRADA_VAULT_EMBEDDING_FALLBACK",
];

describe("retired settings are named, not silently ignored", () => {
  it("lists every retired setting the environment still sets", () => {
    const config = loadConfig({
      ...baseEnv,
      ...Object.fromEntries(RETIRED.map((name) => [name, "1"])),
      GOAL_MAX_DEPTH: "2",
    });

    expect(config.retiredSettings).toEqual(RETIRED);
  });

  it("does not count a blank value as set", () => {
    expect(loadConfig({ ...baseEnv, GOAL_MAX_PARALLEL: "  " }).retiredSettings).toEqual([]);
  });

  it("lists nothing when none is set", () => {
    expect(loadConfig({ ...baseEnv }).retiredSettings).toEqual([]);
  });

  it("no longer refuses to boot over a value nothing reads", () => {
    // Out of the old 1..10 range: this used to throw "Invalid configuration".
    expect(() => loadConfig({ ...baseEnv, GOAL_MAX_PARALLEL: "0", GOAL_MAX_RETRIES: "9" })).not.toThrow();
  });

  it("carries no config field for them, so no code can start trusting one again", () => {
    const config = loadConfig({ ...baseEnv }) as unknown as Record<string, unknown>;
    for (const field of ["goalMaxRetries", "goalMaxFailures", "goalParallelExecution", "goalMaxParallel", "goal"]) {
      expect(config, field).not.toHaveProperty(field);
    }
    expect(config["vault"]).not.toHaveProperty("embeddingFallback");
    // GOAL_MAX_DEPTH is read (stage-goals) and stays.
    expect(config).toHaveProperty("goalMaxDepth");
  });
});
