import { describe, expect, it, vi } from "vitest";

import { withVerifyDeadline } from "./supervisor-brain.js";
import type { NodeResult, VerificationVerdict } from "./supervisor-types.js";

/**
 * A hung verifier used to hold its execution slot for ever: the normal
 * post-dispatch path awaited the call with no deadline and no abort race, so
 * abort could not reach the `finally` that releases the slot and, at
 * concurrency 1, the whole queue stopped behind it (Codex 2026-09-11 M#12).
 */
describe("a verification that never answers", () => {
  const node = { nodeId: "n1", status: "ok", output: "done", provider: "mock" } as unknown as NodeResult;

  it("gives up after the deadline and says nobody answered", async () => {
    vi.useFakeTimers();
    try {
      const never = (): Promise<VerificationVerdict> => new Promise<VerificationVerdict>(() => { /* never settles */ });
      const bounded = withVerifyDeadline(never, 60_000);
      const pending = bounded(node);
      await vi.advanceTimersByTimeAsync(61_000);
      const verdict = await pending;

      expect(verdict.verdict).toBe("skipped");
      expect(verdict.issues?.join(" ")).toContain("did not answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers at once when the run is aborted", async () => {
    const controller = new AbortController();
    const never = (): Promise<VerificationVerdict> => new Promise<VerificationVerdict>(() => { /* never settles */ });
    const pending = withVerifyDeadline(never, 10 * 60_000, controller.signal)(node);
    controller.abort();

    const verdict = await pending;
    expect(verdict.verdict).toBe("skipped");
    expect(verdict.issues?.join(" ")).toContain("aborted");
  });

  it("passes a real verdict straight through", async () => {
    const approve = vi.fn(async (): Promise<VerificationVerdict> => ({ verdict: "approve", verifierProvider: "deepseek" }));
    const verdict = await withVerifyDeadline(approve, 60_000)(node);

    expect(verdict.verdict).toBe("approve");
    expect(approve).toHaveBeenCalledTimes(1);
  });
});
