import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApprovalQueue } from "./approval-queue.js";
import { DaemonStorage } from "../daemon-storage.js";
import { TypedEventBus } from "../../core/event-bus.js";
import type { DaemonEventMap } from "../daemon-events.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ApprovalQueue", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let queue: ApprovalQueue;
  let eventBus: TypedEventBus<DaemonEventMap>;
  const TIMEOUT_MINUTES = 30;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-queue-test-"));
    const dbPath = join(tmpDir, "daemon.db");
    storage = new DaemonStorage(dbPath);
    storage.initialize();
    eventBus = new TypedEventBus<DaemonEventMap>();
    queue = new ApprovalQueue(storage, TIMEOUT_MINUTES, eventBus);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // =========================================================================
  // enqueue
  // =========================================================================

  describe("enqueue()", () => {
    it("creates pending entry with correct expiresAt (createdAt + timeout)", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = queue.enqueue("file_write", { path: "/tmp/test.txt" }, "my-trigger");

      expect(entry.status).toBe("pending");
      expect(entry.toolName).toBe("file_write");
      expect(entry.params).toEqual({ path: "/tmp/test.txt" });
      expect(entry.triggerName).toBe("my-trigger");
      expect(entry.createdAt).toBe(now);
      expect(entry.expiresAt).toBe(now + TIMEOUT_MINUTES * 60 * 1000);
      expect(entry.id).toBeDefined();
      expect(entry.id.length).toBeGreaterThan(0);
    });

    it("emits daemon:approval_requested event", () => {
      const events: unknown[] = [];
      eventBus.on("daemon:approval_requested", (ev) => events.push(ev));

      queue.enqueue("shell_exec", { command: "rm -rf" });

      expect(events).toHaveLength(1);
      expect((events[0] as { toolName: string }).toolName).toBe("shell_exec");
    });
  });

  // =========================================================================
  // getPending
  // =========================================================================

  describe("getPending()", () => {
    it("returns only pending entries", () => {
      const e1 = queue.enqueue("tool_a", {});
      const e2 = queue.enqueue("tool_b", {});
      queue.approve(e1.id, "admin");

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(e2.id);
    });
  });

  // =========================================================================
  // approve
  // =========================================================================

  describe("approve()", () => {
    it("changes status to approved, sets decidedAt and decidedBy", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = queue.enqueue("tool_x", {});
      vi.setSystemTime(now + 5000);
      queue.approve(entry.id, "admin-user");

      const updated = queue.getById(entry.id);
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("approved");
      expect(updated!.decidedBy).toBe("admin-user");
      expect(updated!.decidedAt).toBeDefined();
    });

    it("inserts audit log entry on approve", () => {
      const entry = queue.enqueue("tool_x", {});
      queue.approve(entry.id, "admin");

      const auditLog = queue.getAuditLog();
      expect(auditLog.length).toBeGreaterThanOrEqual(1);
      const lastAudit = auditLog[0];
      expect(lastAudit.toolName).toBe("tool_x");
      expect(lastAudit.decision).toBe("approved");
      expect(lastAudit.decidedBy).toBe("admin");
    });

    it("emits daemon:approval_decided event on approve", () => {
      const events: unknown[] = [];
      eventBus.on("daemon:approval_decided", (ev) => events.push(ev));

      const entry = queue.enqueue("tool_x", {});
      queue.approve(entry.id, "admin");

      expect(events).toHaveLength(1);
      expect((events[0] as { decision: string }).decision).toBe("approved");
    });
  });

  // =========================================================================
  // deny
  // =========================================================================

  describe("deny()", () => {
    it("changes status to denied, sets decidedAt and decidedBy", () => {
      const entry = queue.enqueue("tool_y", {});
      queue.deny(entry.id, "security-bot");

      const updated = queue.getById(entry.id);
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("denied");
      expect(updated!.decidedBy).toBe("security-bot");
    });

    it("inserts audit log entry on deny", () => {
      const entry = queue.enqueue("tool_y", {});
      queue.deny(entry.id, "security-bot");

      const auditLog = queue.getAuditLog();
      expect(auditLog.length).toBeGreaterThanOrEqual(1);
      expect(auditLog[0].decision).toBe("denied");
    });

    it("emits daemon:approval_decided event on deny", () => {
      const events: unknown[] = [];
      eventBus.on("daemon:approval_decided", (ev) => events.push(ev));

      const entry = queue.enqueue("tool_y", {});
      queue.deny(entry.id, "security-bot");

      expect(events).toHaveLength(1);
      expect((events[0] as { decision: string }).decision).toBe("denied");
    });
  });

  // =========================================================================
  // expireStale
  // =========================================================================

  describe("expireStale()", () => {
    it("marks expired pending entries as expired and inserts audit log", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = queue.enqueue("tool_z", {});

      // Fast-forward past expiry
      vi.setSystemTime(now + TIMEOUT_MINUTES * 60 * 1000 + 1);
      queue.expireStale();

      const updated = queue.getById(entry.id);
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("expired");

      const auditLog = queue.getAuditLog();
      const expiredAudit = auditLog.find((a) => a.decision === "expired");
      expect(expiredAudit).toBeDefined();
      expect(expiredAudit!.toolName).toBe("tool_z");
    });

    it("does not expire entries that have not reached timeout", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = queue.enqueue("tool_w", {});

      // Fast-forward but not past expiry
      vi.setSystemTime(now + TIMEOUT_MINUTES * 60 * 1000 - 1000);
      queue.expireStale();

      const updated = queue.getById(entry.id);
      expect(updated!.status).toBe("pending");
    });
  });

  // =========================================================================
  // getById
  // =========================================================================

  describe("getById()", () => {
    it("returns specific entry by id", () => {
      const entry = queue.enqueue("tool_get", { key: "value" });
      const found = queue.getById(entry.id);
      expect(found).toBeDefined();
      expect(found!.toolName).toBe("tool_get");
      expect(found!.params).toEqual({ key: "value" });
    });

    it("returns undefined for non-existent id", () => {
      const found = queue.getById("non-existent-id");
      expect(found).toBeUndefined();
    });
  });

  // =========================================================================
  // Expired entries auto-denied
  // =========================================================================

  describe("expired entries are auto-denied", () => {
    it("expired entries treated as denied (per user decision)", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = queue.enqueue("dangerous_tool", {});

      // Fast-forward past expiry
      vi.setSystemTime(now + TIMEOUT_MINUTES * 60 * 1000 + 1);
      queue.expireStale();

      const updated = queue.getById(entry.id);
      expect(updated!.status).toBe("expired");
      // Expired means denied -- not in pending list
      const pending = queue.getPending();
      expect(pending.find((p) => p.id === entry.id)).toBeUndefined();
    });
  });
});
