/**
 * Agent Core v2 — `LEGAL_FLAG_SETS` + resolvers unit tests (P-F closed matrix, post-Step-5).
 *
 * Cutover Step 5 deleted the v1 engine: the catalogue is now the V2-only ladder
 * (full-control-plane → +scoring+capability → +streaming). Asserts the reject-at-boot
 * validator, the closed-matrix invariants, and the ops-safe DEPRECATED-id aliasing
 * (a stale revert value resolves to the production default instead of crash-looping).
 */

import { describe, it, expect } from "vitest";
import {
  LEGAL_FLAG_SETS,
  PRODUCTION_DEFAULT_FLAG_SET_ID,
  resolveLegalFlagSet,
  resolveFlagSetById,
  type FlagSet,
  type RequestedFlagSet,
} from "./flags.js";

/** Strip the human-readable `id` to produce the comparable `RequestedFlagSet`. */
function asRequested(set: FlagSet): RequestedFlagSet {
  const { id: _id, ...rest } = set;
  return rest;
}

const PROD = LEGAL_FLAG_SETS.find((s) => s.id === PRODUCTION_DEFAULT_FLAG_SET_ID)!;

describe("LEGAL_FLAG_SETS catalogue (post-Step-5: the V2-only ladder)", () => {
  it("PRODUCTION_DEFAULT_FLAG_SET_ID is v2-all-routes + full-control-plane (THE FLIP)", () => {
    expect(PRODUCTION_DEFAULT_FLAG_SET_ID).toBe("v2-all-routes+full-control-plane");
    expect(PROD).toBeDefined();
    expect(PROD).toMatchObject({
      interactive: "v2",
      background: "v2",
      worker: "v2",
      supervisorNode: "v2",
      failureLedger: true,
      runClock: true,
      silenceAccumulator: true,
      typedCancelReason: true,
    });
    expect(resolveFlagSetById(PRODUCTION_DEFAULT_FLAG_SET_ID).id).toBe(PRODUCTION_DEFAULT_FLAG_SET_ID);
  });

  it("contains NO v1-routed set (the v1 engine is deleted)", () => {
    for (const set of LEGAL_FLAG_SETS) {
      expect(set.interactive).toBe("v2");
      expect(set.background).toBe("v2");
      expect(set.worker).toBe("v2");
      expect(set.supervisorNode).toBe("v2");
    }
  });

  it("every set carries the FULL control plane (V2 consumes it)", () => {
    for (const set of LEGAL_FLAG_SETS) {
      expect(set.failureLedger).toBe(true);
      expect(set.runClock).toBe(true);
      expect(set.silenceAccumulator).toBe(true);
      expect(set.typedCancelReason).toBe(true);
    }
  });

  it("has unique set ids", () => {
    const ids = LEGAL_FLAG_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every catalogued set resolves to itself", () => {
    for (const set of LEGAL_FLAG_SETS) {
      expect(resolveLegalFlagSet(asRequested(set))).toBe(set);
    }
  });

  it("streaming only appears on top of the full Phase-3 stack", () => {
    for (const set of LEGAL_FLAG_SETS) {
      if (set.streamVisibleTokens) {
        expect(set.providerRouterScoring).toBe(true);
        expect(set.capabilityRegistry).toBe(true);
      }
    }
  });
});

describe("resolveLegalFlagSet — closed-matrix rejections", () => {
  it("rejects a v1-routed combination (the engine is gone)", () => {
    const illegal: RequestedFlagSet = { ...asRequested(PROD), interactive: "v1" };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/Illegal agent-core flag combination/);
  });

  it("rejects a partial control-plane bundle", () => {
    const illegal: RequestedFlagSet = { ...asRequested(PROD), silenceAccumulator: false };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/not in LEGAL_FLAG_SETS/);
  });

  it("rejects streaming without the full Phase-3 stack", () => {
    const illegal: RequestedFlagSet = { ...asRequested(PROD), streamVisibleTokens: true };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/not in LEGAL_FLAG_SETS/);
  });

  it("rejects scoring without capability (they ship together in Phase 3)", () => {
    const illegal: RequestedFlagSet = { ...asRequested(PROD), providerRouterScoring: true };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/not in LEGAL_FLAG_SETS/);
  });

  it("error message enumerates the legal set ids", () => {
    const illegal: RequestedFlagSet = { ...asRequested(PROD), runClock: false };
    expect(() => resolveLegalFlagSet(illegal)).toThrow(/v2-all-routes\+full-control-plane/);
  });
});

describe("resolveFlagSetById — the AGENT_CORE_FLAG_SET ops knob", () => {
  it("undefined/empty/whitespace → the production default (V2 on every route)", () => {
    expect(resolveFlagSetById(undefined).id).toBe(PRODUCTION_DEFAULT_FLAG_SET_ID);
    expect(resolveFlagSetById("").id).toBe(PRODUCTION_DEFAULT_FLAG_SET_ID);
    expect(resolveFlagSetById("   ").id).toBe(PRODUCTION_DEFAULT_FLAG_SET_ID);
  });

  it("a valid id resolves to that legal set", () => {
    expect(resolveFlagSetById("v2-all+scoring+capability").id).toBe("v2-all+scoring+capability");
    expect(resolveFlagSetById("v2-all+scoring+capability+streaming").streamVisibleTokens).toBe(true);
  });

  it("DEPRECATED rollout-era ids resolve to the production default — never a boot crash", () => {
    // A deployment may still export its documented "instant revert" value; upgrading must not
    // crash-loop the daemon (the ops-safe deprecation the Step-5 deletion shipped with).
    for (const stale of [
      "all-v1",
      "v1-driver+full-control-plane",
      "v1-driver+failure-ledger-only",
      "v2-worker-only+full-control-plane",
      "v2-worker+background+full-control-plane",
    ]) {
      expect(resolveFlagSetById(stale).id).toBe(PRODUCTION_DEFAULT_FLAG_SET_ID);
    }
  });

  it("an UNKNOWN id still rejects at boot (typo guard)", () => {
    expect(() => resolveFlagSetById("v2-al-routes+full-control-plane")).toThrow(
      /Unknown agent-core flag set id/,
    );
  });
});
