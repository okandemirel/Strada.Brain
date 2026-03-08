import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DaemonStorage } from "./daemon-storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ApprovalStatus, CircuitState } from "./daemon-types.js";

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
});
