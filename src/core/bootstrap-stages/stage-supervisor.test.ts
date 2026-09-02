import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../config/config.js";
import type * as winston from "winston";
import { initializeSupervisorStage } from "./stage-supervisor.js";

function createMockLogger(): winston.Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as winston.Logger;
}

function makeConfig(enabled: boolean): Config {
  return {
    supervisor: {
      enabled,
      complexityThreshold: "complex",
      maxParallelNodes: 4,
      nodeTimeoutMs: 5000,
      verificationMode: "disabled",
      verificationBudgetPct: 15,
      triageProvider: "groq",
      maxFailureBudget: 3,
      diversityCap: 0.6,
    },
  } as unknown as Config;
}

/**
 * A Supervisor Brain that failed or was skipped used to leave NO trace where
 * the user reads: two logger.warn lines, nothing in startupNotices, and a boot
 * report that printed "clean" while the whole goal-DAG / wave-dispatch path
 * was absent. Audited 2026-09-02.
 */
describe("initializeSupervisorStage — degradation is reported, not just logged (audited 2026-09-02)", () => {
  it("reports a missing GoalDecomposer through onDegraded", () => {
    const onDegraded = vi.fn();

    const result = initializeSupervisorStage({
      config: makeConfig(true),
      logger: createMockLogger(),
      providerManager: {} as never,
      goalDecomposer: undefined,
      onDegraded,
    });

    expect(result.supervisorBrain).toBeUndefined();
    expect(onDegraded).toHaveBeenCalledTimes(1);
    const notice = onDegraded.mock.calls[0]![0] as string;
    expect(notice).toMatch(/Supervisor Brain unavailable/);
    expect(notice).toMatch(/GoalDecomposer/);
    // Names what is lost, so a "clean" reading is impossible.
    expect(notice).toMatch(/direct worker/i);
  });

  it("reports an initialization failure through onDegraded with its cause", () => {
    const onDegraded = vi.fn();

    const result = initializeSupervisorStage(
      {
        config: makeConfig(true),
        logger: createMockLogger(),
        providerManager: { getProviderByName: () => undefined } as never,
        goalDecomposer: { setDecompositionContext: vi.fn() } as never,
        onDegraded,
      },
      {
        createCapabilityMatcher: () => {
          throw new Error("goals.db is locked");
        },
      },
    );

    expect(result.supervisorBrain).toBeUndefined();
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded.mock.calls[0]![0]).toMatch(/goals\.db is locked/);
  });

  it("stays silent when the supervisor is disabled by configuration", () => {
    const onDegraded = vi.fn();

    const result = initializeSupervisorStage({
      config: makeConfig(false),
      logger: createMockLogger(),
      providerManager: {} as never,
      goalDecomposer: undefined,
      onDegraded,
    });

    expect(result.supervisorBrain).toBeUndefined();
    expect(onDegraded).not.toHaveBeenCalled();
  });
});
