import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DMStateManager,
  DMOperationStatus,
  DMOperationType,
  getOperationTypeFromTool,
  createDMStateManager,
  type DMOperation,
  type OperationQuery,
} from "./dm-state.js";
import type { FileDiff } from "../utils/diff-generator.js";
import type { ApprovalResult } from "./dm-policy.js";

// Mock logger
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createLogger: vi.fn(),
}));

describe("DMStateManager", () => {
  let manager: DMStateManager;

  beforeEach(() => {
    manager = new DMStateManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe("createOperation", () => {
    it("should create operation with generated ID", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test operation",
      });

      expect(op.id).toBeDefined();
      expect(op.id.startsWith("op_")).toBe(true);
      expect(op.confirmationId).toBe("confirm_123");
      expect(op.status).toBe(DMOperationStatus.PENDING);
    });

    it("should include diff when provided", () => {
      const diff: FileDiff = {
        oldPath: "old.ts",
        newPath: "new.ts",
        diff: "diff content",
        stats: { additions: 1, deletions: 1, modifications: 0, totalChanges: 2, hunks: 1 },
        isNew: false,
        isDeleted: false,
        isRename: false,
      };

      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
        diff,
      });

      expect(op.diff).toBe(diff);
      expect(op.stats).toEqual(diff.stats);
    });

    it("should sanitize sensitive tool input", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
        toolInput: {
          path: "test.ts",
          password: "secret123",
          apiKey: "key123",
          token: "tok123",
          secret: "sec123",
          authToken: "auth123",
        },
      });

      expect(op.toolInput).toEqual({
        path: "test.ts",
        password: "[REDACTED]",
        apiKey: "[REDACTED]",
        token: "[REDACTED]",
        secret: "[REDACTED]",
        authToken: "[REDACTED]",
      });
    });

    it("should create session when operation is created", () => {
      manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      const session = manager.getSession("user1", "chat1");
      expect(session).toBeDefined();
      expect(session?.userId).toBe("user1");
      expect(session?.chatId).toBe("chat1");
    });
  });

  describe("getOperation", () => {
    it("should return operation by ID", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      const retrieved = manager.getOperation(op.id);

      expect(retrieved).toEqual(op);
    });

    it("should return undefined for unknown ID", () => {
      const retrieved = manager.getOperation("nonexistent");

      expect(retrieved).toBeUndefined();
    });
  });

  describe("getOperationByConfirmationId", () => {
    it("should return operation by confirmation ID", () => {
      manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      const retrieved = manager.getOperationByConfirmationId("confirm_123");

      expect(retrieved).toBeDefined();
      expect(retrieved?.confirmationId).toBe("confirm_123");
    });

    it("should return undefined for unknown confirmation ID", () => {
      const retrieved = manager.getOperationByConfirmationId("nonexistent");

      expect(retrieved).toBeUndefined();
    });
  });

  describe("updateOperationStatus", () => {
    it("should update status to approved", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      const updated = manager.updateOperationStatus(op.id, DMOperationStatus.APPROVED);

      expect(updated?.status).toBe(DMOperationStatus.APPROVED);
      expect(updated?.resolvedAt).toBeDefined();
    });

    it("should update status to completed with execution result", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      manager.updateOperationStatus(op.id, DMOperationStatus.APPROVED);
      const updated = manager.updateOperationStatus(op.id, DMOperationStatus.COMPLETED, {
        executionResult: "Success",
      });

      expect(updated?.status).toBe(DMOperationStatus.COMPLETED);
      expect(updated?.completedAt).toBeDefined();
      expect(updated?.executionResult).toBe("Success");
    });

    it("should update status to failed with error", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      const updated = manager.updateOperationStatus(op.id, DMOperationStatus.FAILED, {
        errorMessage: "Something went wrong",
      });

      expect(updated?.status).toBe(DMOperationStatus.FAILED);
      expect(updated?.errorMessage).toBe("Something went wrong");
    });

    it("should store approval result", () => {
      const op = manager.createOperation({
        confirmationId: "confirm_123",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Test",
      });

      const approvalResult: ApprovalResult = {
        approved: true,
        action: "approve",
        message: "Approved by user",
      };

      const updated = manager.updateOperationStatus(op.id, DMOperationStatus.APPROVED, {
        approvalResult,
      });

      expect(updated?.approvalResult).toEqual(approvalResult);
    });

    it("should return undefined for unknown operation", () => {
      const updated = manager.updateOperationStatus("nonexistent", DMOperationStatus.APPROVED);

      expect(updated).toBeUndefined();
    });
  });

  describe("queryOperations", () => {
    beforeEach(() => {
      // Create various operations
      manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
        toolName: "file_write",
      });
      manager.createOperation({
        confirmationId: "c2",
        type: DMOperationType.BATCH,
        userId: "user1",
        chatId: "chat2",
        description: "Op2",
        toolName: "shell_exec",
      });
      manager.createOperation({
        confirmationId: "c3",
        type: DMOperationType.DELETE,
        userId: "user2",
        chatId: "chat1",
        description: "Op3",
      });
    });

    it("should filter by userId", () => {
      const results = manager.queryOperations({ userId: "user1" });

      expect(results).toHaveLength(2);
      expect(results.every(op => op.userId === "user1")).toBe(true);
    });

    it("should filter by chatId", () => {
      const results = manager.queryOperations({ chatId: "chat1" });

      expect(results).toHaveLength(2);
      expect(results.every(op => op.chatId === "chat1")).toBe(true);
    });

    it("should filter by status", () => {
      const ops = manager.queryOperations();
      manager.updateOperationStatus(ops[0]!.id, DMOperationStatus.APPROVED);

      const results = manager.queryOperations({ status: DMOperationStatus.APPROVED });

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe(DMOperationStatus.APPROVED);
    });

    it("should filter by multiple statuses", () => {
      const ops = manager.queryOperations();
      manager.updateOperationStatus(ops[0]!.id, DMOperationStatus.APPROVED);
      manager.updateOperationStatus(ops[1]!.id, DMOperationStatus.REJECTED);

      const results = manager.queryOperations({ 
        status: [DMOperationStatus.APPROVED, DMOperationStatus.REJECTED] 
      });

      expect(results).toHaveLength(2);
    });

    it("should filter by type", () => {
      const results = manager.queryOperations({ type: DMOperationType.SINGLE_FILE });

      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe(DMOperationType.SINGLE_FILE);
    });

    it("should filter by toolName", () => {
      const results = manager.queryOperations({ toolName: "file_write" });

      expect(results).toHaveLength(1);
      expect(results[0]?.toolName).toBe("file_write");
    });

    it("should filter by date range", () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const results = manager.queryOperations({ since: yesterday, until: tomorrow });

      expect(results.length).toBeGreaterThan(0);
    });

    it("should sort by createdAt desc", () => {
      const results = manager.queryOperations();

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
          results[i]!.createdAt.getTime()
        );
      }
    });
  });

  describe("getPendingOperations", () => {
    it("should return only pending operations", () => {
      const op1 = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });
      const op2 = manager.createOperation({
        confirmationId: "c2",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op2",
      });

      manager.updateOperationStatus(op1.id, DMOperationStatus.APPROVED);

      const pending = manager.getPendingOperations();

      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(op2.id);
    });
  });

  describe("session management", () => {
    it("should track operations per session", () => {
      const op1 = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });
      manager.createOperation({
        confirmationId: "c2",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat2", // Different chat
        description: "Op2",
      });

      const sessionOps = manager.getSessionOperations("user1", "chat1");

      expect(sessionOps).toHaveLength(1);
      expect(sessionOps[0]?.id).toBe(op1.id);
    });

    it("should set and get active operation", () => {
      const op = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });

      manager.setActiveOperation("user1", "chat1", op.id);

      const active = manager.getActiveOperation("user1", "chat1");
      expect(active?.id).toBe(op.id);
    });

    it("should clear active operation", () => {
      const op = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });

      manager.setActiveOperation("user1", "chat1", op.id);
      manager.clearActiveOperation("user1", "chat1");

      const active = manager.getActiveOperation("user1", "chat1");
      expect(active).toBeUndefined();
    });

    it("should update session stats on approval/rejection", () => {
      const op = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });

      manager.setActiveOperation("user1", "chat1", op.id);
      manager.updateOperationStatus(op.id, DMOperationStatus.APPROVED);

      const session = manager.getSession("user1", "chat1");
      expect(session?.approvedCount).toBe(1);
      expect(session?.rejectedCount).toBe(0);
    });
  });

  describe("cancelSessionPending", () => {
    it("should cancel all pending operations for session", () => {
      const op1 = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });
      const op2 = manager.createOperation({
        confirmationId: "c2",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op2",
      });
      manager.createOperation({
        confirmationId: "c3",
        type: DMOperationType.SINGLE_FILE,
        userId: "user2",
        chatId: "chat1",
        description: "Op3",
      });

      const cancelled = manager.cancelSessionPending("user1", "chat1", "Test cancel");

      expect(cancelled).toBe(2);
      expect(manager.getOperation(op1.id)?.status).toBe(DMOperationStatus.CANCELLED);
      expect(manager.getOperation(op2.id)?.status).toBe(DMOperationStatus.CANCELLED);
    });
  });

  describe("getStatistics", () => {
    it("should return overall statistics", () => {
      const op1 = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });
      const op2 = manager.createOperation({
        confirmationId: "c2",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op2",
      });
      const op3 = manager.createOperation({
        confirmationId: "c3",
        type: DMOperationType.SINGLE_FILE,
        userId: "user2",
        chatId: "chat2",
        description: "Op3",
      });

      // op1: stays APPROVED (approved but not completed)
      manager.updateOperationStatus(op1.id, DMOperationStatus.APPROVED);
      // op2: goes to COMPLETED
      manager.updateOperationStatus(op2.id, DMOperationStatus.APPROVED);
      manager.updateOperationStatus(op2.id, DMOperationStatus.COMPLETED);
      // op3: REJECTED
      manager.updateOperationStatus(op3.id, DMOperationStatus.REJECTED);

      const stats = manager.getStatistics();

      expect(stats.totalOperations).toBe(3);
      expect(stats.pendingCount).toBe(0);
      expect(stats.approvedCount).toBe(1); // op1 still APPROVED
      expect(stats.rejectedCount).toBe(1); // op3 REJECTED
      expect(stats.completedCount).toBe(1); // op2 COMPLETED
      expect(stats.sessionCount).toBe(2);
    });
  });

  describe("getTypeDistribution", () => {
    it("should return count per operation type", () => {
      manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });
      manager.createOperation({
        confirmationId: "c2",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op2",
      });
      manager.createOperation({
        confirmationId: "c3",
        type: DMOperationType.BATCH,
        userId: "user1",
        chatId: "chat1",
        description: "Op3",
      });

      const distribution = manager.getTypeDistribution();

      expect(distribution[DMOperationType.SINGLE_FILE]).toBe(2);
      expect(distribution[DMOperationType.BATCH]).toBe(1);
      expect(distribution[DMOperationType.DELETE]).toBe(0);
    });
  });

  describe("cleanup", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should remove old operations but keep pending", () => {
      manager = new DMStateManager({ maxOperationAgeMs: 100, cleanupIntervalMs: 1000 });

      const oldOp = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Old",
      });
      
      manager.updateOperationStatus(oldOp.id, DMOperationStatus.COMPLETED);

      // Wait for operation to age
      vi.advanceTimersByTime(200);
      manager.cleanup();

      expect(manager.getOperation(oldOp.id)).toBeUndefined();
    });

    it("should keep pending operations regardless of age", () => {
      manager = new DMStateManager({ maxOperationAgeMs: 100, cleanupIntervalMs: 1000 });

      const pendingOp = manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Pending",
      });

      // Wait
      vi.advanceTimersByTime(200);
      manager.cleanup();

      expect(manager.getOperation(pendingOp.id)).toBeDefined();
    });
  });

  describe("exportToJSON", () => {
    it("should export operations and sessions", () => {
      manager.createOperation({
        confirmationId: "c1",
        type: DMOperationType.SINGLE_FILE,
        userId: "user1",
        chatId: "chat1",
        description: "Op1",
      });

      const json = manager.exportToJSON();
      const parsed = JSON.parse(json);

      expect(parsed.operations).toHaveLength(1);
      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.exportedAt).toBeDefined();
    });
  });
});

describe("getOperationTypeFromTool", () => {
  it("should identify write/edit tools", () => {
    expect(getOperationTypeFromTool("file_write")).toBe(DMOperationType.SINGLE_FILE);
    expect(getOperationTypeFromTool("file_edit")).toBe(DMOperationType.SINGLE_FILE);
    expect(getOperationTypeFromTool("str_edit_file")).toBe(DMOperationType.SINGLE_FILE);
  });

  it("should identify delete tools", () => {
    expect(getOperationTypeFromTool("file_delete")).toBe(DMOperationType.DELETE);
    expect(getOperationTypeFromTool("delete_file")).toBe(DMOperationType.DELETE);
  });

  it("should identify rename/move tools", () => {
    expect(getOperationTypeFromTool("file_rename")).toBe(DMOperationType.RENAME);
    expect(getOperationTypeFromTool("move_file")).toBe(DMOperationType.RENAME);
  });

  it("should identify shell tools", () => {
    expect(getOperationTypeFromTool("shell_exec")).toBe(DMOperationType.SHELL);
    expect(getOperationTypeFromTool("exec_command")).toBe(DMOperationType.SHELL);
  });

  it("should identify git tools", () => {
    expect(getOperationTypeFromTool("git_commit")).toBe(DMOperationType.GIT);
    expect(getOperationTypeFromTool("git_push")).toBe(DMOperationType.GIT);
  });

  it("should identify directory tools", () => {
    expect(getOperationTypeFromTool("file_delete_directory")).toBe(DMOperationType.DIRECTORY);
    expect(getOperationTypeFromTool("create_folder")).toBe(DMOperationType.DIRECTORY);
  });

  it("should default to SINGLE_FILE", () => {
    expect(getOperationTypeFromTool("unknown_tool")).toBe(DMOperationType.SINGLE_FILE);
  });
});

describe("createDMStateManager", () => {
  it("should create with default config", () => {
    const mgr = createDMStateManager();
    expect(mgr).toBeInstanceOf(DMStateManager);
    mgr.dispose();
  });

  it("should create with custom config", () => {
    const mgr = createDMStateManager({
      maxOperationsPerSession: 50,
      maxOperationAgeMs: 3600000,
    });
    expect(mgr).toBeInstanceOf(DMStateManager);
    mgr.dispose();
  });
});
