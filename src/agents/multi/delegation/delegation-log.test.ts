/**
 * Tests for DelegationLog
 *
 * Requirements: AGENT-03, AGENT-05
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DelegationLog } from "./delegation-log.js";

describe("DelegationLog", () => {
  let db: Database.Database;
  let log: DelegationLog;

  beforeEach(() => {
    db = new Database(":memory:");
    log = new DelegationLog(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("start", () => {
    it("inserts a running delegation record and returns id", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });
      expect(id).toBeGreaterThan(0);

      const history = log.getHistory(1);
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("running");
      expect(history[0]!.parentAgentId).toBe("agent-1");
      expect(history[0]!.subAgentId).toBe("sub-1");
      expect(history[0]!.type).toBe("code_review");
      expect(history[0]!.model).toBe("deepseek-chat");
      expect(history[0]!.tier).toBe("cheap");
      expect(history[0]!.depth).toBe(0);
    });
  });

  describe("complete", () => {
    it("updates status to completed with duration, cost, and result_summary", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });

      log.complete(id, {
        durationMs: 5000,
        costUsd: 0.003,
        resultSummary: "Review passed",
      });

      const history = log.getHistory(1);
      expect(history[0]!.status).toBe("completed");
      expect(history[0]!.durationMs).toBe(5000);
      expect(history[0]!.costUsd).toBe(0.003);
      expect(history[0]!.resultSummary).toBe("Review passed");
      expect(history[0]!.completedAt).toBeGreaterThan(0);
    });

    it("records escalatedFrom when escalation occurred", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-2",
        type: "analysis",
        model: "claude-sonnet-4-6-20250514",
        tier: "standard",
        depth: 0,
      });

      log.complete(id, {
        durationMs: 15000,
        costUsd: 0.05,
        resultSummary: "Analysis complete",
        escalatedFrom: "cheap",
      });

      const history = log.getHistory(1);
      expect(history[0]!.escalatedFrom).toBe("cheap");
    });
  });

  describe("fail", () => {
    it("updates status to failed with reason", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });

      log.fail(id, "Model returned error");

      const history = log.getHistory(1);
      expect(history[0]!.status).toBe("failed");
      expect(history[0]!.resultSummary).toBe("Model returned error");
      expect(history[0]!.completedAt).toBeGreaterThan(0);
    });

    it("records optional escalatedFrom on failure", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "analysis",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });

      log.fail(id, "Timeout after escalation", "cheap");

      const history = log.getHistory(1);
      expect(history[0]!.escalatedFrom).toBe("cheap");
    });
  });

  describe("timeout", () => {
    it("updates status to timeout", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });

      log.timeout(id);

      const history = log.getHistory(1);
      expect(history[0]!.status).toBe("timeout");
      expect(history[0]!.completedAt).toBeGreaterThan(0);
    });
  });

  describe("cancel", () => {
    it("updates status to cancelled", () => {
      const id = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });

      log.cancel(id);

      const history = log.getHistory(1);
      expect(history[0]!.status).toBe("cancelled");
      expect(history[0]!.completedAt).toBeGreaterThan(0);
    });
  });

  describe("getHistory", () => {
    it("returns records ordered by started_at desc", () => {
      const id1 = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });
      log.complete(id1, { durationMs: 1000, costUsd: 0.001, resultSummary: "ok" });

      const id2 = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-2",
        type: "analysis",
        model: "claude-sonnet-4-6-20250514",
        tier: "standard",
        depth: 0,
      });
      log.complete(id2, { durationMs: 2000, costUsd: 0.002, resultSummary: "ok" });

      const history = log.getHistory();
      expect(history).toHaveLength(2);
      // Most recent first
      expect(history[0]!.startedAt).toBeGreaterThanOrEqual(history[1]!.startedAt);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        log.start({
          parentAgentId: "agent-1",
          subAgentId: `sub-${i}`,
          type: "code_review",
          model: "deepseek-chat",
          tier: "cheap",
          depth: 0,
        });
      }

      const history = log.getHistory(3);
      expect(history).toHaveLength(3);
    });
  });

  describe("getByParent", () => {
    it("filters by parent_agent_id", () => {
      log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });

      log.start({
        parentAgentId: "agent-2",
        subAgentId: "sub-2",
        type: "analysis",
        model: "claude-sonnet-4-6-20250514",
        tier: "standard",
        depth: 0,
      });

      const agent1History = log.getByParent("agent-1");
      expect(agent1History).toHaveLength(1);
      expect(agent1History[0]!.parentAgentId).toBe("agent-1");
    });
  });

  describe("getActiveByParent", () => {
    it("returns only running delegations for a parent", () => {
      const id1 = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });
      log.complete(id1, { durationMs: 1000, costUsd: 0.001, resultSummary: "done" });

      log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-2",
        type: "analysis",
        model: "claude-sonnet-4-6-20250514",
        tier: "standard",
        depth: 0,
      });

      const active = log.getActiveByParent("agent-1");
      expect(active).toHaveLength(1);
      expect(active[0]!.subAgentId).toBe("sub-2");
      expect(active[0]!.status).toBe("running");
    });
  });

  describe("getStats", () => {
    it("returns aggregate stats per type", () => {
      // Two code_review entries
      const id1 = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-1",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });
      log.complete(id1, { durationMs: 5000, costUsd: 0.003, resultSummary: "pass" });

      const id2 = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-2",
        type: "code_review",
        model: "deepseek-chat",
        tier: "cheap",
        depth: 0,
      });
      log.fail(id2, "error");

      // One analysis entry
      const id3 = log.start({
        parentAgentId: "agent-1",
        subAgentId: "sub-3",
        type: "analysis",
        model: "claude-sonnet-4-6-20250514",
        tier: "standard",
        depth: 0,
      });
      log.complete(id3, { durationMs: 15000, costUsd: 0.05, resultSummary: "done" });

      const stats = log.getStats();
      expect(stats.length).toBeGreaterThanOrEqual(2);

      const crStats = stats.find((s) => s.type === "code_review");
      expect(crStats).toBeDefined();
      expect(crStats!.count).toBe(2);
      expect(crStats!.successRate).toBe(0.5); // 1 of 2 succeeded

      const anStats = stats.find((s) => s.type === "analysis");
      expect(anStats).toBeDefined();
      expect(anStats!.count).toBe(1);
      expect(anStats!.successRate).toBe(1.0);
    });
  });
});
