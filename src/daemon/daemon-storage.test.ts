import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DaemonStorage } from "./daemon-storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ApprovalStatus, CircuitState } from "./daemon-types.js";
import type { UrgencyLevel } from "./reporting/notification-types.js";

describe("DaemonStorage", () => {
  let storage: DaemonStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "daemon-storage-test-"));
    const dbPath = join(tmpDir, "daemon.db");
    storage = new DaemonStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Schema creation
  // =========================================================================

  describe("initialize()", () => {
    it("creates all 5 tables", () => {
      const tables = storage.getTableNames();
      expect(tables).toContain("budget_entries");
      expect(tables).toContain("approval_queue");
      expect(tables).toContain("audit_log");
      expect(tables).toContain("circuit_breaker_state");
      expect(tables).toContain("daemon_state");
    });
  });

  // =========================================================================
  // Budget CRUD
  // =========================================================================

  describe("budget entries", () => {
    it("insertBudgetEntry + sumBudgetSince returns correct rolling 24h total", () => {
      const now = Date.now();
      storage.insertBudgetEntry({ costUsd: 1.50, timestamp: now - 1000 });
      storage.insertBudgetEntry({ costUsd: 2.25, timestamp: now - 500 });
      const total = storage.sumBudgetSince(now - 2000);
      expect(total).toBeCloseTo(3.75, 2);
    });

    it("sumBudgetSince correctly excludes entries older than window", () => {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      // Old entry (outside window)
      storage.insertBudgetEntry({ costUsd: 5.00, timestamp: now - oneDay - 1000 });
      // Recent entry (inside window)
      storage.insertBudgetEntry({ costUsd: 2.00, timestamp: now - 1000 });
      const total = storage.sumBudgetSince(now - oneDay);
      expect(total).toBeCloseTo(2.00, 2);
    });

    it("clearBudgetEntries removes all entries", () => {
      storage.insertBudgetEntry({ costUsd: 1.00, timestamp: Date.now() });
      storage.insertBudgetEntry({ costUsd: 2.00, timestamp: Date.now() });
      storage.clearBudgetEntries();
      const total = storage.sumBudgetSince(0);
      expect(total).toBe(0);
    });

    it("getRecentBudgetEntries returns entries ordered by timestamp desc", () => {
      const now = Date.now();
      storage.insertBudgetEntry({ costUsd: 1.00, model: "claude-3", timestamp: now - 2000 });
      storage.insertBudgetEntry({ costUsd: 2.00, model: "claude-3", timestamp: now - 1000 });
      storage.insertBudgetEntry({ costUsd: 3.00, model: "claude-3", timestamp: now });
      const entries = storage.getRecentBudgetEntries(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].costUsd).toBe(3.00);
      expect(entries[1].costUsd).toBe(2.00);
    });

    it("stores optional fields (model, tokensIn, tokensOut, triggerName)", () => {
      storage.insertBudgetEntry({
        costUsd: 0.05,
        model: "claude-3-haiku",
        tokensIn: 100,
        tokensOut: 200,
        triggerName: "morning-check",
        timestamp: Date.now(),
      });
      const entries = storage.getRecentBudgetEntries(1);
      expect(entries[0].model).toBe("claude-3-haiku");
      expect(entries[0].tokensIn).toBe(100);
      expect(entries[0].tokensOut).toBe(200);
      expect(entries[0].triggerName).toBe("morning-check");
    });
  });

  // =========================================================================
  // Approval Queue CRUD
  // =========================================================================

  describe("approval queue", () => {
    const baseApproval = {
      id: "appr-001",
      toolName: "file_write",
      params: { path: "/test.txt", content: "hello" },
      status: "pending" as ApprovalStatus,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000,
    };

    it("insertApproval + getPending returns only pending entries", () => {
      storage.insertApproval(baseApproval);
      storage.insertApproval({ ...baseApproval, id: "appr-002", status: "approved" });
      const pending = storage.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("appr-001");
    });

    it("updateApprovalDecision changes status and sets decidedAt/decidedBy", () => {
      storage.insertApproval(baseApproval);
      storage.updateApprovalDecision("appr-001", "approved", "user123");
      const entry = storage.getApprovalById("appr-001");
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("approved");
      expect(entry!.decidedBy).toBe("user123");
      expect(entry!.decidedAt).toBeDefined();
      expect(entry!.decidedAt).toBeGreaterThan(0);
    });

    it("getExpiredApprovals returns entries past expiresAt with status pending", () => {
      const now = Date.now();
      // Expired entry
      storage.insertApproval({
        ...baseApproval,
        id: "appr-expired",
        expiresAt: now - 1000,
      });
      // Not expired entry
      storage.insertApproval({
        ...baseApproval,
        id: "appr-valid",
        expiresAt: now + 60000,
      });
      // Expired but already approved
      storage.insertApproval({
        ...baseApproval,
        id: "appr-approved",
        status: "approved",
        expiresAt: now - 1000,
      });
      const expired = storage.getExpiredApprovals(now);
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe("appr-expired");
    });

    it("getApprovalById returns undefined for non-existent id", () => {
      const entry = storage.getApprovalById("non-existent");
      expect(entry).toBeUndefined();
    });

    it("stores and retrieves params as JSON", () => {
      const params = { path: "/test.txt", nested: { key: "value" } };
      storage.insertApproval({ ...baseApproval, params });
      const entry = storage.getApprovalById("appr-001");
      expect(entry!.params).toEqual(params);
    });
  });

  // =========================================================================
  // Audit Log CRUD
  // =========================================================================

  describe("audit log", () => {
    it("insertAuditEntry + getRecentAudit returns entries in reverse chronological order", () => {
      const now = Date.now();
      storage.insertAuditEntry({ toolName: "file_read", decision: "allowed", timestamp: now - 2000 });
      storage.insertAuditEntry({ toolName: "file_write", decision: "denied", timestamp: now - 1000 });
      storage.insertAuditEntry({ toolName: "git_status", decision: "allowed", timestamp: now });
      const entries = storage.getRecentAudit(3);
      expect(entries).toHaveLength(3);
      expect(entries[0].toolName).toBe("git_status");
      expect(entries[1].toolName).toBe("file_write");
      expect(entries[2].toolName).toBe("file_read");
    });

    it("stores optional fields (paramsSummary, decidedBy, triggerName)", () => {
      storage.insertAuditEntry({
        toolName: "file_write",
        paramsSummary: "path=/test.txt",
        decision: "approved",
        decidedBy: "user123",
        triggerName: "morning-check",
        timestamp: Date.now(),
      });
      const entries = storage.getRecentAudit(1);
      expect(entries[0].paramsSummary).toBe("path=/test.txt");
      expect(entries[0].decidedBy).toBe("user123");
      expect(entries[0].triggerName).toBe("morning-check");
    });

    it("getRecentAudit respects limit", () => {
      for (let i = 0; i < 10; i++) {
        storage.insertAuditEntry({ toolName: `tool_${i}`, decision: "allowed", timestamp: Date.now() + i });
      }
      const entries = storage.getRecentAudit(5);
      expect(entries).toHaveLength(5);
    });
  });

  // =========================================================================
  // Circuit Breaker State CRUD
  // =========================================================================

  describe("circuit breaker state", () => {
    it("upsertCircuitState + getCircuitState round-trips correctly", () => {
      storage.upsertCircuitState("daily-check", "OPEN", 3, Date.now(), 120000);
      const state = storage.getCircuitState("daily-check");
      expect(state).toBeDefined();
      expect(state!.state).toBe("OPEN");
      expect(state!.consecutiveFailures).toBe(3);
      expect(state!.cooldownMs).toBe(120000);
      expect(state!.lastFailureTime).toBeGreaterThan(0);
    });

    it("upsert overwrites existing state", () => {
      storage.upsertCircuitState("trigger-a", "CLOSED", 0, null, 60000);
      storage.upsertCircuitState("trigger-a", "OPEN", 3, Date.now(), 120000);
      const state = storage.getCircuitState("trigger-a");
      expect(state!.state).toBe("OPEN");
      expect(state!.consecutiveFailures).toBe(3);
    });

    it("getCircuitState returns undefined for unknown trigger", () => {
      const state = storage.getCircuitState("unknown");
      expect(state).toBeUndefined();
    });

    it("getAllCircuitStates returns all states", () => {
      storage.upsertCircuitState("trigger-a", "CLOSED", 0, null, 60000);
      storage.upsertCircuitState("trigger-b", "OPEN", 5, Date.now(), 240000);
      const all = storage.getAllCircuitStates();
      expect(all.size).toBe(2);
      expect(all.get("trigger-a")!.state).toBe("CLOSED");
      expect(all.get("trigger-b")!.state).toBe("OPEN");
    });

    it("deleteCircuitState removes a specific trigger's state", () => {
      storage.upsertCircuitState("trigger-a", "CLOSED", 0, null, 60000);
      storage.upsertCircuitState("trigger-b", "OPEN", 3, Date.now(), 120000);
      storage.deleteCircuitState("trigger-a");
      expect(storage.getCircuitState("trigger-a")).toBeUndefined();
      expect(storage.getCircuitState("trigger-b")).toBeDefined();
    });
  });

  // =========================================================================
  // Daemon State (Key-Value) CRUD
  // =========================================================================

  describe("daemon state", () => {
    it("setDaemonState + getDaemonState round-trips for key-value pairs", () => {
      storage.setDaemonState("last_tick", "2026-03-08T10:00:00Z");
      const value = storage.getDaemonState("last_tick");
      expect(value).toBe("2026-03-08T10:00:00Z");
    });

    it("setDaemonState overwrites existing key", () => {
      storage.setDaemonState("running", "true");
      storage.setDaemonState("running", "false");
      expect(storage.getDaemonState("running")).toBe("false");
    });

    it("getDaemonState returns undefined for non-existent key", () => {
      expect(storage.getDaemonState("non-existent")).toBeUndefined();
    });
  });

  // =========================================================================
  // Phase 18: Notification Buffer, Notification History, Trigger Fire History
  // =========================================================================

  describe("initialize() creates Phase 18 tables", () => {
    it("creates notification_buffer, notification_history, digest_state, and trigger_fire_history tables", () => {
      const tables = storage.getTableNames();
      expect(tables).toContain("notification_buffer");
      expect(tables).toContain("notification_history");
      expect(tables).toContain("digest_state");
      expect(tables).toContain("trigger_fire_history");
    });
  });

  describe("notification buffer", () => {
    it("insertNotificationBuffer persists a row, getBufferedNotifications returns it", () => {
      const now = Date.now();
      storage.insertNotificationBuffer({
        urgency: "medium",
        title: "Budget warning",
        message: "Budget at 80%",
        actionHint: "Run: strata daemon budget reset",
        sourceEvent: "daemon:budget_warning",
        createdAt: now,
      });
      const buffered = storage.getBufferedNotifications();
      expect(buffered).toHaveLength(1);
      expect(buffered[0].urgency).toBe("medium");
      expect(buffered[0].title).toBe("Budget warning");
      expect(buffered[0].message).toBe("Budget at 80%");
      expect(buffered[0].actionHint).toBe("Run: strata daemon budget reset");
      expect(buffered[0].sourceEvent).toBe("daemon:budget_warning");
      expect(buffered[0].createdAt).toBe(now);
    });

    it("clearNotificationBuffer removes all rows", () => {
      storage.insertNotificationBuffer({
        urgency: "low",
        title: "Test 1",
        message: "msg",
        createdAt: Date.now(),
      });
      storage.insertNotificationBuffer({
        urgency: "high",
        title: "Test 2",
        message: "msg",
        createdAt: Date.now(),
      });
      storage.clearNotificationBuffer();
      expect(storage.getBufferedNotifications()).toHaveLength(0);
    });

    it("notification buffer respects max size -- oldest low-urgency dropped when full, high/critical never dropped", () => {
      // Fill buffer to max=5 with mixed urgency
      for (let i = 0; i < 3; i++) {
        storage.insertNotificationBuffer({
          urgency: "low",
          title: `Low ${i}`,
          message: "msg",
          createdAt: Date.now() + i,
        });
      }
      storage.insertNotificationBuffer({
        urgency: "high",
        title: "High 1",
        message: "msg",
        createdAt: Date.now() + 10,
      });
      storage.insertNotificationBuffer({
        urgency: "critical",
        title: "Critical 1",
        message: "msg",
        createdAt: Date.now() + 20,
      });

      // Prune to max 3, protecting high and critical
      storage.pruneNotificationBuffer(3, ["high", "critical"]);

      const remaining = storage.getBufferedNotifications();
      // Should have 3 total: high, critical, and 1 low
      expect(remaining).toHaveLength(3);
      const urgencies = remaining.map((r) => r.urgency);
      expect(urgencies).toContain("high");
      expect(urgencies).toContain("critical");
    });
  });

  describe("notification history", () => {
    it("insertNotificationHistory persists, getNotificationHistory returns sorted by created_at DESC", () => {
      const now = Date.now();
      storage.insertNotificationHistory({
        urgency: "low",
        title: "Task complete",
        message: "Goal finished",
        deliveredTo: ["dashboard"],
        createdAt: now - 1000,
      });
      storage.insertNotificationHistory({
        urgency: "high",
        title: "Budget exceeded",
        message: "Over limit",
        deliveredTo: ["chat", "dashboard"],
        createdAt: now,
      });

      const history = storage.getNotificationHistory(10);
      expect(history).toHaveLength(2);
      expect(history[0].title).toBe("Budget exceeded"); // most recent first
      expect(history[0].deliveredTo).toEqual(["chat", "dashboard"]);
      expect(history[1].title).toBe("Task complete");
    });

    it("getNotificationHistory respects level filter", () => {
      const now = Date.now();
      storage.insertNotificationHistory({
        urgency: "low",
        title: "Low entry",
        message: "msg",
        deliveredTo: ["dashboard"],
        createdAt: now,
      });
      storage.insertNotificationHistory({
        urgency: "high",
        title: "High entry",
        message: "msg",
        deliveredTo: ["chat"],
        createdAt: now + 1,
      });

      const highOnly = storage.getNotificationHistory(10, "high");
      expect(highOnly).toHaveLength(1);
      expect(highOnly[0].title).toBe("High entry");
    });
  });

  describe("trigger fire history", () => {
    it("insertTriggerFireHistory persists, getTriggerFireHistory returns per-trigger sorted by timestamp DESC with limit", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        storage.insertTriggerFireHistory({
          triggerName: "daily-check",
          result: i % 2 === 0 ? "success" : "failure",
          durationMs: 100 + i * 10,
          taskId: `task-${i}`,
          timestamp: now + i * 1000,
        });
      }
      // Different trigger
      storage.insertTriggerFireHistory({
        triggerName: "morning-scan",
        result: "success",
        durationMs: 50,
        timestamp: now + 10000,
      });

      const dailyHistory = storage.getTriggerFireHistory("daily-check", 3);
      expect(dailyHistory).toHaveLength(3);
      // Most recent first
      expect(dailyHistory[0].timestamp).toBeGreaterThan(dailyHistory[1].timestamp);
      expect(dailyHistory[0].result).toBe("success"); // i=4
      expect(dailyHistory[1].result).toBe("failure"); // i=3
    });

    it("trigger fire history auto-prunes entries beyond configured depth per trigger", () => {
      const now = Date.now();
      // Insert 10 entries
      for (let i = 0; i < 10; i++) {
        storage.insertTriggerFireHistory({
          triggerName: "auto-prune-test",
          result: "success",
          timestamp: now + i * 1000,
        });
      }

      // Prune to keep 3
      storage.pruneTriggerFireHistory("auto-prune-test", 3);

      const remaining = storage.getTriggerFireHistory("auto-prune-test", 100);
      expect(remaining).toHaveLength(3);
      // Should keep the 3 most recent
      expect(remaining[0].timestamp).toBe(now + 9000);
    });
  });

  describe("digest_state via daemon state pattern", () => {
    it("digest_state get/set works via existing setDaemonState/getDaemonState pattern", () => {
      storage.setDaemonState("digest:last_sent", String(Date.now()));
      storage.setDaemonState("digest:trigger_count", "15");
      storage.setDaemonState("digest:task_count", "8");

      expect(storage.getDaemonState("digest:last_sent")).toBeDefined();
      expect(storage.getDaemonState("digest:trigger_count")).toBe("15");
      expect(storage.getDaemonState("digest:task_count")).toBe("8");
    });
  });
});
