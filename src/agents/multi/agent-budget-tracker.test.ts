/**
 * Tests for AgentBudgetTracker -- per-agent budget tracking with hierarchical rollup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { createAgentId } from "./agent-types.js";
import type { AgentId } from "./agent-types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AgentBudgetTracker", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let tracker: AgentBudgetTracker;
  let agentA: AgentId;
  let agentB: AgentId;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-budget-test-"));
    const dbPath = join(tmpDir, "daemon.db");
    storage = new DaemonStorage(dbPath);
    storage.initialize();
    tracker = new AgentBudgetTracker(storage);
    tracker.initialize();
    agentA = createAgentId();
    agentB = createAgentId();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // =========================================================================
  // recordCost + getAgentUsage
  // =========================================================================

  describe("recordCost + getAgentUsage", () => {
    it("stores entry with agent_id and retrieves per-agent usage", () => {
      tracker.recordCost(agentA, 1.5);
      tracker.recordCost(agentA, 0.5);

      const usage = tracker.getAgentUsage(agentA, 5.0);
      expect(usage.usedUsd).toBeCloseTo(2.0, 2);
      expect(usage.limitUsd).toBe(5.0);
      expect(usage.pct).toBeCloseTo(0.4, 2);
    });

    it("isolates costs between agents", () => {
      tracker.recordCost(agentA, 3.0);
      tracker.recordCost(agentB, 1.0);

      const usageA = tracker.getAgentUsage(agentA, 5.0);
      const usageB = tracker.getAgentUsage(agentB, 5.0);

      expect(usageA.usedUsd).toBeCloseTo(3.0, 2);
      expect(usageB.usedUsd).toBeCloseTo(1.0, 2);
    });

    it("returns zero usage for agent with no costs", () => {
      const usage = tracker.getAgentUsage(agentA, 5.0);
      expect(usage.usedUsd).toBe(0);
      expect(usage.pct).toBe(0);
    });

    it("returns pct 0 when no capUsd provided", () => {
      tracker.recordCost(agentA, 2.0);
      const usage = tracker.getAgentUsage(agentA);
      expect(usage.usedUsd).toBeCloseTo(2.0, 2);
      expect(usage.pct).toBe(0);
    });

    it("accepts optional model, tokensIn, tokensOut, triggerName", () => {
      tracker.recordCost(agentA, 0.5, {
        model: "claude-3-haiku",
        tokensIn: 100,
        tokensOut: 200,
        triggerName: "test-trigger",
      });
      const usage = tracker.getAgentUsage(agentA, 5.0);
      expect(usage.usedUsd).toBeCloseTo(0.5, 2);
    });
  });

  // =========================================================================
  // getGlobalUsage
  // =========================================================================

  describe("getGlobalUsage", () => {
    it("includes all agents in global usage", () => {
      tracker.recordCost(agentA, 2.0);
      tracker.recordCost(agentB, 1.5);

      const global = tracker.getGlobalUsage(10.0);
      expect(global.usedUsd).toBeCloseTo(3.5, 2);
      expect(global.pct).toBeCloseTo(0.35, 2);
    });

    it("includes legacy (null agent_id) entries in global usage", () => {
      // Insert a legacy entry without agent_id
      storage.insertBudgetEntry({
        costUsd: 1.0,
        timestamp: Date.now(),
      });
      tracker.recordCost(agentA, 2.0);

      const global = tracker.getGlobalUsage(10.0);
      expect(global.usedUsd).toBeCloseTo(3.0, 2);
    });

    it("returns pct 0 when no globalCapUsd provided", () => {
      tracker.recordCost(agentA, 5.0);
      const global = tracker.getGlobalUsage();
      expect(global.usedUsd).toBeCloseTo(5.0, 2);
      expect(global.pct).toBe(0);
    });
  });

  // =========================================================================
  // isAgentExceeded
  // =========================================================================

  describe("isAgentExceeded", () => {
    it("returns false when under cap", () => {
      tracker.recordCost(agentA, 3.0);
      expect(tracker.isAgentExceeded(agentA, 5.0)).toBe(false);
    });

    it("returns true when usage >= cap", () => {
      tracker.recordCost(agentA, 5.0);
      expect(tracker.isAgentExceeded(agentA, 5.0)).toBe(true);
    });

    it("returns true when usage exceeds cap", () => {
      tracker.recordCost(agentA, 7.0);
      expect(tracker.isAgentExceeded(agentA, 5.0)).toBe(true);
    });

    it("returns false for agent with no costs", () => {
      expect(tracker.isAgentExceeded(agentA, 5.0)).toBe(false);
    });
  });

  // =========================================================================
  // Legacy entries (null agent_id) isolation
  // =========================================================================

  describe("legacy entry isolation", () => {
    it("legacy entries do NOT appear in per-agent queries", () => {
      // Insert legacy entry (no agent_id)
      storage.insertBudgetEntry({
        costUsd: 10.0,
        timestamp: Date.now(),
      });

      const usage = tracker.getAgentUsage(agentA, 5.0);
      expect(usage.usedUsd).toBe(0);
    });

    it("legacy entries DO appear in global queries", () => {
      storage.insertBudgetEntry({
        costUsd: 2.5,
        timestamp: Date.now(),
      });

      const global = tracker.getGlobalUsage(10.0);
      expect(global.usedUsd).toBeCloseTo(2.5, 2);
    });
  });

  // =========================================================================
  // Rolling 24h window
  // =========================================================================

  describe("rolling 24h window", () => {
    it("excludes entries older than 24h from per-agent usage", () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Entry from 25 hours ago (outside window)
      vi.setSystemTime(now - 25 * 60 * 60 * 1000);
      tracker.recordCost(agentA, 3.0);

      // Entry from 1 hour ago (inside window)
      vi.setSystemTime(now - 1 * 60 * 60 * 1000);
      tracker.recordCost(agentA, 1.0);

      // Check at "now"
      vi.setSystemTime(now);
      const usage = tracker.getAgentUsage(agentA, 5.0);
      expect(usage.usedUsd).toBeCloseTo(1.0, 2);
    });
  });

  // =========================================================================
  // getAllAgentUsages
  // =========================================================================

  describe("getAllAgentUsages", () => {
    it("returns per-agent totals grouped by agent_id", () => {
      tracker.recordCost(agentA, 2.0);
      tracker.recordCost(agentA, 1.0);
      tracker.recordCost(agentB, 0.5);

      const usages = tracker.getAllAgentUsages();
      expect(usages.get(agentA)).toBeCloseTo(3.0, 2);
      expect(usages.get(agentB)).toBeCloseTo(0.5, 2);
    });

    it("does not include legacy (null agent_id) entries", () => {
      storage.insertBudgetEntry({
        costUsd: 5.0,
        timestamp: Date.now(),
      });
      tracker.recordCost(agentA, 1.0);

      const usages = tracker.getAllAgentUsages();
      expect(usages.size).toBe(1);
      expect(usages.get(agentA)).toBeCloseTo(1.0, 2);
    });

    it("returns empty map when no agent costs", () => {
      const usages = tracker.getAllAgentUsages();
      expect(usages.size).toBe(0);
    });
  });

  // =========================================================================
  // reservations — the check-then-act guard
  // =========================================================================

  describe("reservations", () => {
    it("makes in-flight work visible to the next caller's cap check", () => {
      tracker.recordCost(agentA, 9.5);
      expect(tracker.getAgentCommitment(agentA, 10).committedUsd).toBeCloseTo(9.5, 4);

      tracker.reserve(agentA, 0.4);
      tracker.reserve(agentA, 0.4);

      const commitment = tracker.getAgentCommitment(agentA, 10);
      // Spend and reservation stay separately named — a reservation is not spend.
      expect(commitment.usedUsd).toBeCloseTo(9.5, 4);
      expect(commitment.reservedUsd).toBeCloseTo(0.8, 4);
      expect(commitment.committedUsd).toBeCloseTo(10.3, 4);
    });

    it("keeps one agent's reservations out of another's commitment", () => {
      tracker.reserve(agentA, 1.0);
      expect(tracker.getAgentReservedUsd(agentB)).toBe(0);
    });

    it("release() returns the headroom without charging anything", () => {
      const id = tracker.reserve(agentA, 1.0);
      tracker.release(id);

      expect(tracker.getAgentReservedUsd(agentA)).toBe(0);
      expect(tracker.getAgentUsage(agentA).usedUsd).toBe(0);
    });

    it("settle() replaces the reservation with the real cost", () => {
      const id = tracker.reserve(agentA, 1.0);
      tracker.settle(id, agentA, 0.25, { model: "test-model" });

      expect(tracker.getAgentReservedUsd(agentA)).toBe(0);
      expect(tracker.getAgentUsage(agentA).usedUsd).toBeCloseTo(0.25, 4);
    });

    it("settle() does not re-charge costs already streamed in against the reservation", () => {
      const id = tracker.reserve(agentA, 1.0);
      // Live per-turn billing while the work runs.
      tracker.recordCost(agentA, 0.1, { reservationId: id });
      tracker.recordCost(agentA, 0.15, { reservationId: id });
      // Each recorded turn shrinks the headroom the estimate still holds.
      expect(tracker.getAgentReservedUsd(agentA)).toBeCloseTo(0.75, 4);

      tracker.settle(id, agentA, 0.25);

      expect(tracker.getAgentUsage(agentA).usedUsd).toBeCloseTo(0.25, 4);
      expect(tracker.getAgentReservedUsd(agentA)).toBe(0);
    });

    it("settle() records the overrun when the real cost beat the estimate", () => {
      const id = tracker.reserve(agentA, 0.2);
      tracker.recordCost(agentA, 0.2, { reservationId: id });
      tracker.settle(id, agentA, 0.9);

      expect(tracker.getAgentUsage(agentA).usedUsd).toBeCloseTo(0.9, 4);
    });

    it("drops a reservation that outlived the ceiling instead of shrinking the cap forever", () => {
      vi.useFakeTimers();
      try {
        tracker.reserve(agentA, 5.0);
        expect(tracker.getAgentReservedUsd(agentA)).toBeCloseTo(5.0, 4);

        vi.advanceTimersByTime(61 * 60 * 1000);

        expect(
          tracker.getAgentReservedUsd(agentA),
          "a leaked reservation kept holding headroom",
        ).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // migrateAgentBudget idempotency
  // =========================================================================

  describe("migration idempotency", () => {
    it("calling initialize multiple times does not throw", () => {
      // beforeEach already called initialize() once, call it again
      expect(() => tracker.initialize()).not.toThrow();
      expect(() => tracker.initialize()).not.toThrow();
    });
  });
});
