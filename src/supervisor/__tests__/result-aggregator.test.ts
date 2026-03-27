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
  });
});
