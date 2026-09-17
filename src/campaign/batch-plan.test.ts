/**
 * The batch-planning contract (plan 0-B.4, 0-B.5, 1.6; Codex 2026-09-13
 * AK#3, AK#4, AK#5): one place for what "all", the catalogue, the allowance
 * and the headroom mean.
 */
import { describe, expect, it } from "vitest";
import { largestDeadlineThatFits, planSessionBatch } from "./batch-plan.js";
import { PLAY_RUN_BUDGET_MS, sessionsThatFitOneRun } from "./producer-evidence.js";

describe("planSessionBatch", () => {
  it("discovers an unknown catalogue: 'all' only when the producer's whole cap fits, otherwise ONE session (AK#4)", () => {
    // Short rounds: the cap fits, and the producer resolves "all" against what it reads now.
    expect(planSessionBatch({ played: [], deadlineSeconds: 45, bootSeconds: 30 })).toMatchObject({ kind: "discover", sessions: "all" });
    // Long rounds: five fit, twelve do not — a range guessed from time asked
    // a three-level game for levels 4 and 5, so the first run plays one
    // session and learns the catalogue.
    expect(planSessionBatch({ played: [], deadlineSeconds: 465, bootSeconds: 30 })).toMatchObject({ kind: "discover", sessions: "1" });
  });

  it("clips a known catalogue to itself and to what fits, and walks it across runs (AJ#11)", () => {
    expect(planSessionBatch({ catalogue: 3, played: [], deadlineSeconds: 465, bootSeconds: 30 })).toMatchObject({ kind: "batch", sessions: "1-3" });
    expect(planSessionBatch({ catalogue: 13, played: [], deadlineSeconds: 45, bootSeconds: 30 })).toMatchObject({ kind: "batch", sessions: "1-12" });
    expect(planSessionBatch({ catalogue: 13, played: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], deadlineSeconds: 45, bootSeconds: 30 })).toMatchObject({ kind: "batch", sessions: "13" });
    expect(planSessionBatch({ catalogue: 13, played: [1, 3], deadlineSeconds: 45, bootSeconds: 30 })).toMatchObject({ kind: "batch", sessions: "2,4,5,6,7,8,9,10,11,12,13" });
    // Everything played: a re-measurement, never a claim of coverage.
    expect(planSessionBatch({ catalogue: 13, played: Array.from({ length: 13 }, (_u, i) => i + 1), deadlineSeconds: 45, bootSeconds: 30 })).toMatchObject({ kind: "covered", sessions: "1-12" });
    // A small game nobody played yet, when the whole cap fits: "all", so a game that grew is played whole.
    expect(planSessionBatch({ catalogue: 3, played: [], deadlineSeconds: 45, bootSeconds: 30 })).toMatchObject({ kind: "batch", sessions: "all" });
  });

  it("a legal 1800 s round whose headroom overshoots the budget is trimmed to what fits, and disclosed (AK#5)", () => {
    // The coordinator's allowance: 1800 × 1.5 + 15 = 2715 s; one run may take 2700 s.
    expect(sessionsThatFitOneRun(2715, 30)).toBe(0);
    const largest = largestDeadlineThatFits(30);
    expect(largest).toBe(Math.floor((PLAY_RUN_BUDGET_MS - 45_000 - 30_000) / 1000) - 5);
    const plan = planSessionBatch({ catalogue: 2, played: [], roundSeconds: 1800, deadlineSeconds: 2715, bootSeconds: 30 });
    expect(plan).toMatchObject({ kind: "batch", sessions: "1", deadlineSeconds: largest });
    expect(plan.kind === "batch" ? plan.trimmed : "").toContain("trimmed from 2715 s");
  });

  it("a round that itself exceeds one run's budget is refused by name — never the same request again (AK#5)", () => {
    const plan = planSessionBatch({ catalogue: 2, played: [], roundSeconds: 3000, deadlineSeconds: 4515, bootSeconds: 30 });
    expect(plan.kind).toBe("unfit");
    expect(plan.kind === "unfit" ? plan.reason : "").toContain("a round of 3000 s cannot be played in one run");
    expect(plan.kind === "unfit" ? plan.reason : "").toContain("no resumable run is available");
  });
});
