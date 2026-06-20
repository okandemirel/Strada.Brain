/**
 * Agent Core v2 — Phase 1a flag-plumbing tests.
 *
 * Asserts the new `v1-driver+failure-ledger-only` isolation set is the ONLY newly-legal
 * single-concern combo: failureLedger alone resolves, but any larger partial bundle (e.g.
 * +runClock) still rejects, and the Phase-0 default keeps failureLedger OFF.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLAG_SET,
  resolveLegalFlagSet,
  type RequestedFlagSet,
} from "./flags.js";

describe("Phase 1a — failureLedger isolation set", () => {
  it("resolves failureLedger-only to v1-driver+failure-ledger-only", () => {
    const requested: RequestedFlagSet = { ...DEFAULT_FLAG_SET, failureLedger: true };
    expect(resolveLegalFlagSet(requested).id).toBe("v1-driver+failure-ledger-only");
  });

  it("the resolved isolation set keeps the other 3 control-plane concerns OFF", () => {
    const set = resolveLegalFlagSet({ ...DEFAULT_FLAG_SET, failureLedger: true });
    expect(set.failureLedger).toBe(true);
    expect(set.runClock).toBe(false);
    expect(set.silenceAccumulator).toBe(false);
    expect(set.typedCancelReason).toBe(false);
    expect(set.interactive).toBe("v1");
    expect(set.background).toBe("v1");
    expect(set.worker).toBe("v1");
    expect(set.supervisorNode).toBe("v1");
  });

  it("still rejects failureLedger + runClock (partial bundle beyond the isolation set)", () => {
    const requested: RequestedFlagSet = {
      ...DEFAULT_FLAG_SET,
      failureLedger: true,
      runClock: true,
    };
    expect(() => resolveLegalFlagSet(requested)).toThrow(/Illegal agent-core flag combination/);
  });

  it("still rejects the other lone control-plane sub-flags (only failureLedger is isolable)", () => {
    for (const lone of ["runClock", "silenceAccumulator", "typedCancelReason"] as const) {
      const requested: RequestedFlagSet = { ...DEFAULT_FLAG_SET, [lone]: true };
      expect(() => resolveLegalFlagSet(requested)).toThrow(/not in LEGAL_FLAG_SETS/);
    }
  });

  it("the Phase-0 default keeps failureLedger OFF (seam installed, inert)", () => {
    expect(resolveLegalFlagSet(DEFAULT_FLAG_SET).failureLedger).toBe(false);
  });
});
