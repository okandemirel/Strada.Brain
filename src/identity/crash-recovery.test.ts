import { describe, it, expect } from "vitest";
import {
  buildCrashRecoveryContext,
  formatDowntime,
} from "./crash-recovery.js";
import { makeIdentityState, makeGoalTree } from "../test-helpers.js";

describe("buildCrashRecoveryContext", () => {
  it("returns CrashRecoveryContext with wasCrash=true, identity state, and interrupted trees", () => {
    const state = makeIdentityState({ lastActivityTs: Date.now() - 300000, cleanShutdown: false });
    const trees = [makeGoalTree("Build player system"), makeGoalTree("Setup inventory")];

    const result = buildCrashRecoveryContext(true, state, trees);

    expect(result).not.toBeNull();
    expect(result!.wasCrash).toBe(true);
    expect(result!.downtimeMs).toBeGreaterThanOrEqual(280000); // ~5 min
    expect(result!.downtimeMs).toBeLessThanOrEqual(320000);
    expect(result!.lastActivityTs).toBe(state.lastActivityTs);
    expect(result!.bootCount).toBe(5);
    expect(result!.interruptedTrees).toHaveLength(2);
  });

  it("returns null when wasCrash is false (clean restart)", () => {
    const state = makeIdentityState({ cleanShutdown: true });

    const result = buildCrashRecoveryContext(false, state, []);

    expect(result).toBeNull();
  });

  it("returns context with empty interruptedTrees when wasCrash=true but no interrupted trees", () => {
    const state = makeIdentityState({ cleanShutdown: false });

    const result = buildCrashRecoveryContext(true, state, []);

    expect(result).not.toBeNull();
    expect(result!.wasCrash).toBe(true);
    expect(result!.interruptedTrees).toHaveLength(0);
  });
});

describe("formatDowntime", () => {
  it('formats 300000ms as "5 minutes"', () => {
    expect(formatDowntime(300000)).toBe("5 minutes");
  });

  it('formats 7200000ms as "2 hours 0 minutes"', () => {
    expect(formatDowntime(7200000)).toBe("2 hours 0 minutes");
  });

  it('formats 30000ms as "less than a minute"', () => {
    expect(formatDowntime(30000)).toBe("less than a minute");
  });

  it('formats 0ms as "less than a minute"', () => {
    expect(formatDowntime(0)).toBe("less than a minute");
  });

  it('formats 60000ms as "1 minute"', () => {
    expect(formatDowntime(60000)).toBe("1 minute");
  });

  it('formats 3600000ms as "1 hour 0 minutes"', () => {
    expect(formatDowntime(3600000)).toBe("1 hour 0 minutes");
  });

  it('formats 86400000ms as "1 day 0 hours"', () => {
    expect(formatDowntime(86400000)).toBe("1 day 0 hours");
  });

  it('formats 90060000ms (1 day 1 hour 1 minute) as "1 day 1 hour"', () => {
    expect(formatDowntime(90060000)).toBe("1 day 1 hour");
  });

  it('formats 180000000ms (2 days 2 hours) as "2 days 2 hours"', () => {
    expect(formatDowntime(180000000)).toBe("2 days 2 hours");
  });
});
