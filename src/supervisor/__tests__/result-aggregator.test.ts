import { describe, it, expect, vi } from "vitest";
import { ResultAggregator } from "../result-aggregator.js";
import type { NodeResult, VerificationConfig } from "../supervisor-types.js";

function makeResult(nodeId: string, status: "ok" | "failed" | "skipped", output = "done"): NodeResult {
  return {
    nodeId: nodeId as any, status, output,
    artifacts: [], toolResults: [],
    provider: "claude", model: "claude-sonnet",
    cost: 0.001, duration: 1000,
  };
}

describe("ResultAggregator", () => {
  describe("collect", () => {
    it("separates results by status", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "ok", "Schema created"),
        makeResult("B", "failed", "Error"),
        { ...makeResult("C", "failed", "Need user input"), blockedReason: "Need user input" },
        makeResult("D", "ok", "Endpoint ready"),
        makeResult("E", "skipped"),
      ];
      const collected = agg.collect(results);
      expect(collected.succeeded).toHaveLength(2);
      expect(collected.failed).toHaveLength(1);
      expect(collected.blocked).toHaveLength(1);
      expect(collected.skipped).toHaveLength(1);
    });
  });

  describe("synthesize", () => {
    it("produces full success output", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "ok", "DB schema created with users table"),
        makeResult("B", "ok", "JWT middleware implemented"),
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(true);
      expect(output.partial).toBe(false);
      expect(output.output).toContain("DB schema");
      expect(output.output).toContain("JWT middleware");
      expect(output.succeeded).toBe(2);
      expect(output.totalCost).toBeCloseTo(0.002);
    });

    it("does not let a cancelled sibling downgrade an otherwise-successful task (audit #13)", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "ok", "Implemented the feature"),
        { ...makeResult("B", "ok", "was cut short"), status: "cancelled" as const },
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(true);   // NOT downgraded to blocked/failed
      expect(output.partial).toBe(true);   // but flagged partial (a node was cancelled)
      expect(output.failed).toBe(0);       // cancelled is NOT counted as a failure
      expect(output.output).toContain("Implemented the feature");
    });

    it("excludes cancelled nodes from the failure count in a mixed result", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "ok", "done"),
        makeResult("B", "failed", "real error"),
        { ...makeResult("C", "ok", "cut short"), status: "cancelled" as const },
      ];
      const output = agg.synthesize(results);
      expect(output.failed).toBe(1);       // only the genuinely-failed node
      expect(output.succeeded).toBe(1);
    });

    it("produces partial success output", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "ok", "Schema created"),
        makeResult("B", "failed", "Rate limit exceeded"),
        makeResult("C", "skipped"),
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(false);
      expect(output.partial).toBe(true);
      expect(output.succeeded).toBe(1);
      expect(output.failed).toBe(1);
      expect(output.skipped).toBe(1);
    });

    it("produces total failure output", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "failed", "Error 1"),
        makeResult("B", "failed", "Error 2"),
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(false);
      expect(output.partial).toBe(false);
    });

    // audited 2026-09-02: the "All nodes failed" branch fired on succeeded===0 &&
    // blocked===0 without checking that anything failed, and rendered only the
    // failed list — so an all-skipped run (SUPERVISOR_MAX_FAILURE_BUDGET=0) said
    // "All nodes failed:" over an empty list with failed:0, and 3 failed + 1
    // skipped said "All nodes failed" while listing 3 of 4. The mixed branch
    // then rendered every skip as the bare word "skipped", erasing the reason
    // the dispatcher recorded (budget exhausted vs dependency failed).
    it("does not say 'All nodes failed' when zero nodes failed (all skipped)", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "skipped", "Skipped: budget exhausted"),
        makeResult("B", "skipped", "Skipped: budget exhausted"),
        makeResult("C", "skipped", "Skipped: budget exhausted"),
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(false);
      expect(output.partial).toBe(false);
      expect(output.failed).toBe(0);
      expect(output.skipped).toBe(3);
      expect(output.output).not.toContain("All nodes failed");
      expect(output.output).toContain("No node succeeded: 0 failed, 3 skipped, 0 cancelled");
      expect(output.output).toContain("[A] Skipped: budget exhausted");
    });

    it("does not say 'All nodes failed' when some nodes were skipped or cancelled, and names the skip reason", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "failed", "boom A"),
        makeResult("B", "failed", "boom B"),
        makeResult("C", "skipped", "Skipped: dependency failed"),
        { ...makeResult("D", "ok", "cut short"), status: "cancelled" as const },
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(false);
      expect(output.failed).toBe(2);
      expect(output.skipped).toBe(1);
      expect(output.output).not.toContain("All nodes failed");
      expect(output.output).toContain("No node succeeded: 2 failed, 1 skipped, 1 cancelled");
      expect(output.output).toContain("[A] boom A");
      expect(output.output).toContain("[C] Skipped: dependency failed");
    });

    it("keeps the skip reason in a partial result", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        makeResult("A", "ok", "did A"),
        makeResult("B", "skipped", "Skipped: budget exhausted"),
        makeResult("C", "skipped", "Skipped: dependency failed"),
      ];
      const output = agg.synthesize(results);
      expect(output.partial).toBe(true);
      expect(output.output).toContain("[B] Skipped: budget exhausted");
      expect(output.output).toContain("[C] Skipped: dependency failed");
    });

    it("treats blocked node results as partial work instead of total failure", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results = [
        { ...makeResult("A", "failed", "Need clarification from the user"), blockedReason: "Need clarification from the user" },
        { ...makeResult("B", "failed", "Missing API credentials"), blockedReason: "Missing API credentials" },
      ];
      const output = agg.synthesize(results);
      expect(output.success).toBe(false);
      expect(output.partial).toBe(true);
      expect(output.failed).toBe(2);
      expect(output.output).toContain("Blocked:");
      expect(output.output).toContain("Need clarification from the user");
      expect(output.output).toContain("Missing API credentials");
    });
  });

  describe("detectConflicts", () => {
    it("detects file conflicts between nodes", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results: NodeResult[] = [
        { ...makeResult("A", "ok"), artifacts: [{ path: "src/auth.ts", action: "modify" }] },
        { ...makeResult("B", "ok"), artifacts: [{ path: "src/auth.ts", action: "modify" }, { path: "src/db.ts", action: "create" }] },
        { ...makeResult("C", "ok"), artifacts: [{ path: "src/db.ts", action: "modify" }] },
      ];
      const conflicts = agg.detectConflicts(results);
      expect(conflicts).toContain("src/auth.ts");
      expect(conflicts).toContain("src/db.ts");
    });

    it("returns empty when no conflicts", () => {
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 });
      const results: NodeResult[] = [
        { ...makeResult("A", "ok"), artifacts: [{ path: "src/auth.ts", action: "create" }] },
        { ...makeResult("B", "ok"), artifacts: [{ path: "src/db.ts", action: "create" }] },
      ];
      const conflicts = agg.detectConflicts(results);
      expect(conflicts).toHaveLength(0);
    });
  });

  describe("verify", () => {
    it("skips verification in disabled mode", async () => {
      const verifyFn = vi.fn();
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 }, verifyFn);
      const results = [makeResult("A", "ok")];
      const verified = await agg.verify(results);
      expect(verified).toEqual(results);
      expect(verifyFn).not.toHaveBeenCalled();
    });

    // audited 2026-09-02: verify() returned the array untouched when nothing was
    // verified, and the caller could not tell that apart from a full pass.
    it("reports zero verified nodes in disabled mode instead of an implicit pass", async () => {
      const verifyFn = vi.fn();
      const agg = new ResultAggregator({ mode: "disabled", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 }, verifyFn);
      const { results, report } = await agg.verifyWithReport([makeResult("A", "ok"), makeResult("B", "failed")]);
      expect(results).toHaveLength(2);
      expect(report).toEqual({ candidates: 1, verified: 0, approved: 0, flagged: 0, rejected: 0, notVerified: 1 });
    });

    it("counts a 'skipped' verdict as not verified, and flags/rejects as verified", async () => {
      const verifyFn = vi.fn()
        .mockResolvedValueOnce({ verdict: "skipped", verifierProvider: "claude", issues: ["not critical"] })
        .mockResolvedValueOnce({ verdict: "flag_issues", verifierProvider: "deepseek", issues: ["no verifier"] })
        .mockResolvedValueOnce({ verdict: "reject", verifierProvider: "deepseek", issues: ["broken"] });
      const agg = new ResultAggregator({ mode: "always", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 }, verifyFn);
      const { results, report } = await agg.verifyWithReport([makeResult("A", "ok"), makeResult("B", "ok"), makeResult("C", "ok")]);
      expect(report).toEqual({ candidates: 3, verified: 2, approved: 0, flagged: 1, rejected: 1, notVerified: 1 });
      expect(results[0]).toMatchObject({ nodeId: "A", status: "ok", output: "done" }); // skipped: untouched
      expect(results[2]).toMatchObject({ nodeId: "C", status: "failed" });
    });

    it("verifies all nodes in always mode", async () => {
      const verifyFn = vi.fn().mockResolvedValue({ verdict: "approve", verifierProvider: "deepseek" });
      const agg = new ResultAggregator({ mode: "always", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 }, verifyFn);
      const results = [makeResult("A", "ok"), makeResult("B", "ok")];
      await agg.verify(results);
      expect(verifyFn).toHaveBeenCalledTimes(2);
    });

    it("only verifies ok results (skips failed/skipped)", async () => {
      const verifyFn = vi.fn().mockResolvedValue({ verdict: "approve", verifierProvider: "deepseek" });
      const agg = new ResultAggregator({ mode: "always", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 }, verifyFn);
      const results = [makeResult("A", "ok"), makeResult("B", "failed"), makeResult("C", "skipped")];
      await agg.verify(results);
      expect(verifyFn).toHaveBeenCalledTimes(1); // only "A"
    });

    it("marks explicitly rejected nodes as failed while keeping result order stable", async () => {
      const verifyFn = vi.fn()
        .mockResolvedValueOnce({ verdict: "reject", verifierProvider: "deepseek", issues: ["Missing verification"] })
        .mockResolvedValueOnce({ verdict: "approve", verifierProvider: "deepseek" });
      const agg = new ResultAggregator({ mode: "always", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 15 }, verifyFn);
      const results = [makeResult("A", "ok"), makeResult("B", "ok")];

      const verified = await agg.verify(results);

      expect(verified[0]).toMatchObject({
        nodeId: "A",
        status: "failed",
        output: "Verification rejected: Missing verification",
      });
      expect(verified[1]).toMatchObject({
        nodeId: "B",
        status: "ok",
      });
    });

    it("stops verifying once the configured verification budget would be exceeded", async () => {
      const verifyFn = vi.fn().mockResolvedValue({ verdict: "approve", verifierProvider: "deepseek" });
      const agg = new ResultAggregator({ mode: "always", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 0.15 }, verifyFn);
      const results = [
        { ...makeResult("A", "ok"), cost: 1 },
        { ...makeResult("B", "ok"), cost: 1 },
      ];

      await agg.verify(results);

      expect(verifyFn).toHaveBeenCalledTimes(1);
      expect(verifyFn).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "A" }));
    });

    it("continues verifying cheaper nodes after one node exceeds the budget (M16)", async () => {
      const verifyFn = vi.fn().mockResolvedValue({ verdict: "approve", verifierProvider: "deepseek" });
      const agg = new ResultAggregator(
        { mode: "always", samplingRate: 0, preferDifferentProvider: true, maxVerificationCost: 0.15 },
        verifyFn,
      );
      const results = [
        { ...makeResult("A", "ok"), cost: 10 }, // est 1.0 — exceeds budget, must NOT abort the loop
        { ...makeResult("B", "ok"), cost: 0.5 }, // est 0.05 — fits
      ];

      await agg.verify(results);

      // TEETH: the unfixed `break` aborted at A (iterated first), so verifyFn was never called.
      expect(verifyFn).toHaveBeenCalledTimes(1);
      expect(verifyFn).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "B" }));
      expect(verifyFn).not.toHaveBeenCalledWith(expect.objectContaining({ nodeId: "A" }));
    });
  });
});
