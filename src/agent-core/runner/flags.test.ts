/**
 * Agent Core v2 — `LEGAL_FLAG_SETS` + `resolveLegalFlagSet` unit tests (P-F closed matrix).
 *
 * Asserts the reject-at-boot validator: the Phase-0 default `all-v1` resolves, every catalogued
 * set is self-consistent and resolvable, and the four closed-matrix invariants reject — a V2
 * route with no control plane, a partial control-plane bundle, streaming without the full
 * Phase-3 stack, and capability/scoring without V2-everywhere.
 */

import { describe, it, expect } from "vitest";
import {
  LEGAL_FLAG_SETS,
  DEFAULT_FLAG_SET,
  DEFAULT_FLAG_SET_ID,
  resolveLegalFlagSet,
  type FlagSet,
  type RequestedFlagSet,
} from "./flags.js";

/** Strip the human-readable `id` to produce the comparable `RequestedFlagSet`. */
function asRequested(set: FlagSet): RequestedFlagSet {
  const { id: _id, ...rest } = set;
  return rest;
}

describe("LEGAL_FLAG_SETS catalogue", () => {
  it("contains the Phase-0 default and it is all-v1 with no control plane", () => {
    const def = LEGAL_FLAG_SETS.find((s) => s.id === DEFAULT_FLAG_SET_ID);
    expect(def).toBeDefined();
    expect(def).toMatchObject({
      interactive: "v1",
      background: "v1",
      worker: "v1",
      supervisorNode: "v1",
      failureLedger: false,
      runClock: false,
      silenceAccumulator: false,
      typedCancelReason: false,
      providerRouterScoring: false,
      capabilityRegistry: false,
      streamVisibleTokens: false,
    });
  });

  it("has unique set ids", () => {
    const ids = LEGAL_FLAG_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DEFAULT_FLAG_SET matches the all-v1 catalogued set", () => {
    const def = LEGAL_FLAG_SETS.find((s) => s.id === DEFAULT_FLAG_SET_ID)!;
    expect(DEFAULT_FLAG_SET).toEqual(asRequested(def));
  });

  it("every catalogued set resolves to itself", () => {
    for (const set of LEGAL_FLAG_SETS) {
      expect(resolveLegalFlagSet(asRequested(set))).toBe(set);
    }
  });

  it("never lists a V2 route with the control plane disabled (invariant)", () => {
    for (const set of LEGAL_FLAG_SETS) {
      const anyV2 =
        set.interactive === "v2" ||
        set.background === "v2" ||
        set.worker === "v2" ||
        set.supervisorNode === "v2";
      if (anyV2) {
        expect(set.failureLedger).toBe(true);
        expect(set.runClock).toBe(true);
        expect(set.silenceAccumulator).toBe(true);
        expect(set.typedCancelReason).toBe(true);
      }
    }
  });
});

describe("resolveLegalFlagSet — accepts the default", () => {
  it("resolves DEFAULT_FLAG_SET to the all-v1 set", () => {
    expect(resolveLegalFlagSet(DEFAULT_FLAG_SET).id).toBe("all-v1");
  });
});

describe("resolveLegalFlagSet — closed-matrix rejections", () => {
  it("rejects a V2 route with no control plane", () => {
    const illegal: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      worker: "v2", // V2 route, but FULL_CP stays false
    };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/Illegal agent-core flag combination/);
  });

  it("rejects a partial control-plane bundle (uncatalogued two-flag combo)", () => {
    // Phase 1a made `failureLedger` alone legal; Phase 1b made failureLedger+runClock legal.
    // Pick a still-uncatalogued pair to keep asserting the closed-matrix rejection:
    // failureLedger+silenceAccumulator (silence without runClock) has no set and must reject.
    const illegal: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: true,
      silenceAccumulator: true,
    };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/not in LEGAL_FLAG_SETS/);
  });

  it("accepts failureLedger in isolation (Phase 1a set)", () => {
    const phase1a: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: true,
    };
    expect(resolveLegalFlagSet(phase1a).id).toBe("v1-driver+failure-ledger-only");
  });

  it("accepts failureLedger + runClock (Phase 1b set)", () => {
    const phase1b: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: true,
      runClock: true,
    };
    expect(resolveLegalFlagSet(phase1b).id).toBe("v1-driver+failure-ledger+run-clock");
  });

  it("accepts failureLedger + runClock + silenceAccumulator (Phase 1c set)", () => {
    const phase1c: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: true,
      runClock: true,
      silenceAccumulator: true,
    };
    expect(resolveLegalFlagSet(phase1c).id).toBe(
      "v1-driver+failure-ledger+run-clock+silence-accumulator",
    );
  });

  it("rejects silenceAccumulator WITHOUT runClock (1c requires the accumulator's producer)", () => {
    // silenceAccumulator IS the RunClock task-scope signal; turning it on without runClock
    // would leave a consumer with no producer. The combo is uncatalogued → reject-at-boot.
    const illegal: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: true,
      runClock: false,
      silenceAccumulator: true,
    };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/not in LEGAL_FLAG_SETS/);
  });

  it("rejects silenceAccumulator WITHOUT failureLedger (1c requires the ledger to escalate)", () => {
    // The accumulator escalates through the ledger's VerdictInput (rule 4); with the ledger
    // off the verdict is inert. The combo is uncatalogued → reject-at-boot.
    const illegal: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: false,
      runClock: true,
      silenceAccumulator: true,
    };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/Illegal agent-core flag combination/);
  });

  it("rejects streamVisibleTokens without the full Phase-3 stack", () => {
    const illegal: RequestedFlagSet = {
      interactive: "v2",
      background: "v2",
      worker: "v2",
      supervisorNode: "v2",
      failureLedger: true,
      runClock: true,
      silenceAccumulator: true,
      typedCancelReason: true,
      providerRouterScoring: false, // missing scoring + capability
      capabilityRegistry: false,
      streamVisibleTokens: true,
    };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/Illegal agent-core flag combination/);
  });

  it("rejects capabilityRegistry/providerRouterScoring without V2 everywhere", () => {
    const illegal: RequestedFlagSet = {
      interactive: "v1", // not V2-all
      background: "v2",
      worker: "v2",
      supervisorNode: "v2",
      failureLedger: true,
      runClock: true,
      silenceAccumulator: true,
      typedCancelReason: true,
      providerRouterScoring: true,
      capabilityRegistry: true,
      streamVisibleTokens: false,
    };
    expect(() => resolveLegalFlagSet(illegal)).toThrow();
  });

  it("error message enumerates the legal set ids", () => {
    try {
      resolveLegalFlagSet({ ...DEFAULT_FLAG_SET, worker: "v2" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const set of LEGAL_FLAG_SETS) {
        expect(message).toContain(set.id);
      }
    }
  });
});
