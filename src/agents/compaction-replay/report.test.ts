/**
 * The compaction A/B report must not price an arm that does not fit the
 * context window as if it could be chosen. The arm results are invented.
 */
import { describe, expect, it } from "vitest";
import { formatReport, notViableLines, type ReplayReport } from "./report.js";
import type { ArmResult } from "./replay.js";

const arm = (over: Partial<ArmResult> & Pick<ArmResult, "arm" | "kind">): ArmResult => ({
  sessions: 1,
  calls: 10,
  events: 0,
  backstops: 0,
  inputTokens: 1_000_000,
  cachedStableHead: 900_000,
  cachedLoggedHead: 40_000,
  costStableHead: 118_000,
  costLoggedHead: 960_800,
  requestMedian: 90_000,
  requestP90: 120_000,
  requestMax: 125_000,
  callsOverWindow: 0,
  ...over,
});

const report = (arms: ArmResult[]): ReplayReport => ({
  source: "shape",
  inputs: ["strada-brain.log"],
  contextWindow: 128_000,
  priceNote: "relative",
  arms,
  fidelity: { calls: 0, medianAbsError: null, p90AbsError: null },
  churn: { transitions: 9, promptChanged: 9, toolsChanged: 0 },
});

const rowOf = (text: string, name: string): string[] =>
  text.split("\n").find((l) => l.startsWith(name))!.slice(name.length).trim().split(/\s{2,}/);

describe("compaction replay report", () => {
  const appendOnly = arm({ arm: "append-only (reference)", kind: "append-only", costStableHead: 100_000, requestMax: 219_951, callsOverWindow: 3 });
  const current = arm({ arm: "current (session-compaction.ts)", kind: "current", events: 4 });
  const cliff = arm({ arm: "cliff 48k->16k, min 8k", kind: "cliff", events: 2, costStableHead: 129_800 });

  it("prints each arm's calls over the window, and no cost comparison for an arm that has any", () => {
    const text = formatReport(report([appendOnly, current, cliff]));
    // Columns after the name: events, backstops, input, median, p90, max, over window, cached, cost, vs current, cached, cost, vs current.
    const ref = rowOf(text, appendOnly.arm);
    expect(ref[6]).toBe("3");
    expect([ref[9], ref[12]]).toEqual(["not viable", "not viable"]);
    const c = rowOf(text, cliff.arm);
    expect(c[6]).toBe("0");
    expect([c[9], c[12]]).toEqual(["+10.0%", "+0.0%"]);
    expect(rowOf(text, current.arm)[6]).toBe("0");
  });

  it("says in words which arm does not fit the window, and says nothing when every arm fits", () => {
    expect(notViableLines([appendOnly, current, cliff], 128_000)).toEqual([
      'NOT VIABLE at a 128,000-token window: "append-only (reference)" sent 3 of 10 call(s) larger than the window ' +
        "(max 219,951), which a provider refuses; its cost is a reference, not an option.",
    ]);
    expect(formatReport(report([appendOnly, current, cliff]))).toContain(notViableLines([appendOnly], 128_000)[0]);
    expect(notViableLines([current, cliff], 128_000)).toEqual([]);
    expect(formatReport(report([current, cliff]))).not.toMatch(/NOT VIABLE|not viable/);
  });
});
