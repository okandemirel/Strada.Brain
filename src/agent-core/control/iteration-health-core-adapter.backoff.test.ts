/**
 * Agent Core v2 — Phase 1a: E2-A backoff-fidelity tests for IterationHealthCoreAdapter.
 *
 * The adapter MUST neutralize the off-by-one between v1's APPLIED backoff (the value
 * recordFailure RETURNS, read at the PRE-increment index) and the tracker's only public
 * query getBackoffMs() (which reads the POST-increment index). These tests both (a) assert
 * the adapter serves v1's applied schedule, and (b) PIN the delta the naive bind would
 * introduce — so a regression to `backoffMs() => tracker.getBackoffMs()` fails loudly.
 */
import { describe, expect, it } from "vitest";
import {
  BACKOFF_SCHEDULE_MS,
  IterationHealthTracker,
} from "../../agents/iteration-health-tracker.js";
import { IterationHealthCoreAdapter } from "./iteration-health-core-adapter.js";

describe("E2-A backoff fidelity (adapter neutralizes the off-by-one)", () => {
  it("adapter.backoffMs() over the PRE-abort failures == v1's applied (pre-increment) schedule", () => {
    // Drive only failures 1-4 (all non-terminal): the served delays are exactly v1's
    // pre-increment schedule. The 5th failure aborts (no backoff) and is asserted separately.
    const tracker = new IterationHealthTracker(0);
    const adapter = new IterationHealthCoreAdapter(tracker, "p");
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      adapter.recordFailure(); // ledger records exactly once per failure
      seen.push(adapter.backoffMs()); // ledger reads the delay HERE
    }
    // v1 truth: the value recordFailure RETURNS, i.e. the schedule at the pre-increment index.
    expect(seen).toEqual(BACKOFF_SCHEDULE_MS.slice(0, 4)); // [0, 10_000, 30_000, 60_000]
  });

  it("serves 0 backoff on the aborting (5th) failure — v1 applies NO backoff on abort", () => {
    // v1's abort FailureAction carries no backoffMs and the loop never sleeps on abort; the
    // adapter mirrors that by serving 0 (the abort verdict carries no delay).
    const tracker = new IterationHealthTracker(0);
    const adapter = new IterationHealthCoreAdapter(tracker, "p");
    for (let i = 0; i < 4; i++) adapter.recordFailure();
    adapter.recordFailure(); // 5th → abort (rate 1.0, consecutive 5)
    expect(tracker.shouldAbort()).toBe(true);
    expect(adapter.backoffMs()).toBe(0);
  });

  it("PINS the delta the NAIVE bind would introduce (getBackoffMs is one rung too high)", () => {
    // The bug we are NOT shipping — asserted so a regression to getBackoffMs() is caught.
    const tracker = new IterationHealthTracker(0);
    const correct: number[] = []; // pre-increment (what the adapter serves)
    const naive: number[] = []; // post-increment (what getBackoffMs would serve)
    for (let i = 0; i < 4; i++) {
      const action = tracker.recordFailure("p"); // advances backoffIndex internally
      correct.push(action.kind === "abort" ? 0 : action.backoffMs);
      naive.push(tracker.getBackoffMs());
    }
    expect(correct).toEqual([0, 10_000, 30_000, 60_000]);
    expect(naive).toEqual([10_000, 30_000, 60_000, 120_000]); // shifted up exactly one rung
    expect(naive).not.toEqual(correct); // the delta is real, and we avoid it
  });

  it("recordSuccess resets the served backoff to 0 (mirrors tracker backoffIndex reset)", () => {
    const tracker = new IterationHealthTracker(0);
    const adapter = new IterationHealthCoreAdapter(tracker, "p");
    adapter.recordFailure();
    adapter.recordFailure(); // index advanced
    adapter.recordSuccess();
    adapter.recordFailure(); // first failure after reset
    expect(adapter.backoffMs()).toBe(0); // back to schedule[0], not mid-schedule
  });

  it("backoffMs() is 0 before any failure (no stale read)", () => {
    const tracker = new IterationHealthTracker(0);
    const adapter = new IterationHealthCoreAdapter(tracker, "p");
    expect(adapter.backoffMs()).toBe(0);
  });
});
