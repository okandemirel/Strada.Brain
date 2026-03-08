import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DaemonSecurityPolicy } from "./daemon-security-policy.js";
import { ApprovalQueue } from "./approval-queue.js";
import { DaemonStorage } from "../daemon-storage.js";
import { TypedEventBus } from "../../core/event-bus.js";
import type { DaemonEventMap } from "../daemon-events.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("DaemonSecurityPolicy", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let queue: ApprovalQueue;
  let eventBus: TypedEventBus<DaemonEventMap>;
  let policy: DaemonSecurityPolicy;

  // Mock metadata lookup
  const metadataMap = new Map<string, { readOnly: boolean }>([
    ["file_read", { readOnly: true }],
    ["grep_search", { readOnly: true }],
    ["git_status", { readOnly: true }],
    ["file_write", { readOnly: false }],
    ["file_create", { readOnly: false }],
    ["file_edit", { readOnly: false }],
    ["shell_exec", { readOnly: false }],
    ["git_commit", { readOnly: false }],
    ["analyze_project", { readOnly: true }],
    ["auto_tool", { readOnly: false }],
  ]);

  const lookupMetadata = (name: string) => metadataMap.get(name);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "security-policy-test-"));
    const dbPath = join(tmpDir, "daemon.db");
    storage = new DaemonStorage(dbPath);
    storage.initialize();
    eventBus = new TypedEventBus<DaemonEventMap>();
    queue = new ApprovalQueue(storage, 30, eventBus);
    const autoApproveList = new Set(["auto_tool", "file_write"]);
    policy = new DaemonSecurityPolicy(lookupMetadata, queue, autoApproveList);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // checkPermission
  // =========================================================================

  describe("checkPermission()", () => {
    it("returns 'allow' for read-only tool (readOnly: true in metadata)", () => {
      expect(policy.checkPermission("file_read")).toBe("allow");
      expect(policy.checkPermission("grep_search")).toBe("allow");
      expect(policy.checkPermission("git_status")).toBe("allow");
    });

    it("returns 'queue' for write tool (readOnly: false)", () => {
      expect(policy.checkPermission("shell_exec")).toBe("queue");
      expect(policy.checkPermission("git_commit")).toBe("queue");
    });

    it("returns 'allow' for auto-approved tool even if not readOnly", () => {
      expect(policy.checkPermission("auto_tool")).toBe("allow");
    });

    it("returns 'queue' for tool not in registry (safe default)", () => {
      expect(policy.checkPermission("unknown_tool")).toBe("queue");
    });

    it("returns 'queue' for file_write even if in auto-approve list", () => {
      // file_write is in the auto-approve list but should still require approval
      expect(policy.checkPermission("file_write")).toBe("queue");
    });

    it("returns 'queue' for file_create even if not specifically in auto-approve list", () => {
      expect(policy.checkPermission("file_create")).toBe("queue");
    });

    it("returns 'queue' for file_edit (always requires approval)", () => {
      expect(policy.checkPermission("file_edit")).toBe("queue");
    });
  });

  // =========================================================================
  // requestApproval
  // =========================================================================

  describe("requestApproval()", () => {
    it("write tool enqueues for approval and returns pending entry", () => {
      const entry = policy.requestApproval(
        "shell_exec",
        { command: "rm -rf /" },
        "cleanup-trigger",
      );

      expect(entry.status).toBe("pending");
      expect(entry.toolName).toBe("shell_exec");
      expect(entry.params).toEqual({ command: "rm -rf /" });
      expect(entry.triggerName).toBe("cleanup-trigger");
    });

    it("enqueued entry is visible in approval queue", () => {
      const entry = policy.requestApproval("git_commit", { message: "test" });

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(entry.id);
    });
  });

  // =========================================================================
  // Full flow
  // =========================================================================

  describe("full security flow", () => {
    it("read-only tool bypasses queue entirely", () => {
      const permission = policy.checkPermission("file_read");
      expect(permission).toBe("allow");

      // Queue should be empty
      expect(queue.getPending()).toHaveLength(0);
    });

    it("file write tools always require approval even if auto-approved", () => {
      // file_write is in auto-approve list
      const permission = policy.checkPermission("file_write");
      expect(permission).toBe("queue");
    });

    it("auto-approved non-file-write tool executes immediately", () => {
      const permission = policy.checkPermission("auto_tool");
      expect(permission).toBe("allow");
    });
  });
});
