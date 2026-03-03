import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DMPolicy,
  ApprovalLevel,
  isDestructiveOperation,
  createDMPolicy,
  type SessionApprovalPrefs,
  type DMPolicyConfig,
} from "./dm-policy.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { FileDiff, BatchDiff } from "../utils/diff-generator.js";

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

// Mock channel adapter
const createMockChannel = (): IChannelAdapter => ({
  name: "test",
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  sendText: vi.fn().mockResolvedValue(undefined),
  sendMarkdown: vi.fn().mockResolvedValue(undefined),
  sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
  requestConfirmation: vi.fn().mockResolvedValue("Yes"),
  isHealthy: vi.fn().mockReturnValue(true),
});

// Mock diff data
const createMockFileDiff = (overrides: Partial<FileDiff> = {}): FileDiff => ({
  oldPath: "test.ts",
  newPath: "test.ts",
  diff: "mock diff",
  stats: { additions: 5, deletions: 3, modifications: 2, totalChanges: 8, hunks: 1 },
  isNew: false,
  isDeleted: false,
  isRename: false,
  ...overrides,
});

const createMockBatchDiff = (fileCount: number = 2): BatchDiff => ({
  files: Array.from({ length: fileCount }, (_, i) =>
    createMockFileDiff({ newPath: `file${i}.ts` })
  ),
  totalStats: {
    additions: fileCount * 5,
    deletions: fileCount * 3,
    modifications: fileCount * 2,
    totalChanges: fileCount * 8,
    hunks: fileCount,
  },
  summary: `${fileCount} changed`,
});

describe("DMPolicy", () => {
  let policy: DMPolicy;
  let mockChannel: IChannelAdapter;

  beforeEach(() => {
    mockChannel = createMockChannel();
    policy = new DMPolicy(mockChannel);
  });

  describe("getSessionPrefs", () => {
    it("should return default prefs for new session", () => {
      const prefs = policy.getSessionPrefs("user1", "chat1");

      expect(prefs.userId).toBe("user1");
      expect(prefs.level).toBe(ApprovalLevel.SMART);
      expect(prefs.smartFileThreshold).toBe(3);
      expect(prefs.smartLineThreshold).toBe(50);
    });

    it("should return same prefs for existing session", () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      
      const prefs = policy.getSessionPrefs("user1", "chat1");

      expect(prefs.level).toBe(ApprovalLevel.ALWAYS);
    });

    it("should create separate prefs for different users", () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      policy.setSessionPrefs("user2", "chat1", { level: ApprovalLevel.NEVER });

      expect(policy.getSessionPrefs("user1", "chat1").level).toBe(ApprovalLevel.ALWAYS);
      expect(policy.getSessionPrefs("user2", "chat1").level).toBe(ApprovalLevel.NEVER);
    });

    it("should reset expired prefs", () => {
      const pastDate = new Date(Date.now() - 1000);
      policy.setSessionPrefs("user1", "chat1", { 
        level: ApprovalLevel.ALWAYS,
        expiresAt: pastDate 
      });

      const prefs = policy.getSessionPrefs("user1", "chat1");

      expect(prefs.level).toBe(ApprovalLevel.SMART); // Reset to default
    });
  });

  describe("setSessionPrefs", () => {
    it("should update existing prefs", () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.NEVER });

      const prefs = policy.getSessionPrefs("user1", "chat1");
      expect(prefs.level).toBe(ApprovalLevel.NEVER);
    });

    it("should preserve unchanged fields", () => {
      policy.setSessionPrefs("user1", "chat1", { 
        level: ApprovalLevel.ALWAYS,
        smartFileThreshold: 10 
      });
      policy.setSessionPrefs("user1", "chat1", { smartLineThreshold: 100 });

      const prefs = policy.getSessionPrefs("user1", "chat1");
      expect(prefs.level).toBe(ApprovalLevel.ALWAYS);
      expect(prefs.smartFileThreshold).toBe(10);
      expect(prefs.smartLineThreshold).toBe(100);
    });
  });

  describe("isApprovalRequired", () => {
    it("should return false for NEVER level", () => {
      const prefs: SessionApprovalPrefs = {
        userId: "user1",
        level: ApprovalLevel.NEVER,
        smartFileThreshold: 3,
        smartLineThreshold: 50,
      };
      const diff = createMockFileDiff();

      expect(policy.isApprovalRequired(prefs, diff, false)).toBe(false);
      expect(policy.isApprovalRequired(prefs, diff, true)).toBe(false);
    });

    it("should return true for ALWAYS level", () => {
      const prefs: SessionApprovalPrefs = {
        userId: "user1",
        level: ApprovalLevel.ALWAYS,
        smartFileThreshold: 3,
        smartLineThreshold: 50,
      };
      const diff = createMockFileDiff();

      expect(policy.isApprovalRequired(prefs, diff, false)).toBe(true);
    });

    it("should return true for DESTRUCTIVE_ONLY when destructive", () => {
      const prefs: SessionApprovalPrefs = {
        userId: "user1",
        level: ApprovalLevel.DESTRUCTIVE_ONLY,
        smartFileThreshold: 3,
        smartLineThreshold: 50,
      };
      const diff = createMockFileDiff();

      expect(policy.isApprovalRequired(prefs, diff, true)).toBe(true);
      expect(policy.isApprovalRequired(prefs, diff, false)).toBe(false);
    });

    it("should check thresholds for SMART level", () => {
      const prefs: SessionApprovalPrefs = {
        userId: "user1",
        level: ApprovalLevel.SMART,
        smartFileThreshold: 3,
        smartLineThreshold: 50,
      };
      const smallDiff = createMockFileDiff({ stats: { additions: 1, deletions: 1, modifications: 0, totalChanges: 2, hunks: 1 } });
      const largeDiff = createMockFileDiff({ stats: { additions: 30, deletions: 30, modifications: 0, totalChanges: 60, hunks: 5 } });

      expect(policy.isApprovalRequired(prefs, smallDiff, false)).toBe(false);
      expect(policy.isApprovalRequired(prefs, largeDiff, false)).toBe(true);
    });

    it("should always require approval for destructive in SMART mode", () => {
      const prefs: SessionApprovalPrefs = {
        userId: "user1",
        level: ApprovalLevel.SMART,
        smartFileThreshold: 100,
        smartLineThreshold: 1000,
      };
      const smallDiff = createMockFileDiff({ stats: { additions: 1, deletions: 1, modifications: 0, totalChanges: 2, hunks: 1 } });

      expect(policy.isApprovalRequired(prefs, smallDiff, true)).toBe(true);
    });

    it("should check batch thresholds for SMART level", () => {
      const prefs: SessionApprovalPrefs = {
        userId: "user1",
        level: ApprovalLevel.SMART,
        smartFileThreshold: 3,
        smartLineThreshold: 50,
      };
      const smallBatch = createMockBatchDiff(2);
      const largeBatch = createMockBatchDiff(5);

      expect(policy.isApprovalRequired(prefs, smallBatch, false)).toBe(false);
      expect(policy.isApprovalRequired(prefs, largeBatch, false)).toBe(true);
    });
  });

  describe("requestApproval", () => {
    it("should auto-approve when not required", async () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.NEVER });
      const diff = createMockFileDiff();

      const result = await policy.requestApproval("chat1", "user1", diff, "test op");

      expect(result.approved).toBe(true);
      expect(result.action).toBe("approve");
      expect(result.message).toContain("Auto-approved");
    });

    it("should request confirmation when required", async () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      const diff = createMockFileDiff();

      // Mock response
      vi.mocked(mockChannel.sendMarkdown).mockResolvedValue(undefined);
      
      // Start the request but don't await yet
      const requestPromise = policy.requestApproval("chat1", "user1", diff, "test op");
      
      // Wait a bit for the confirmation to be registered
      await new Promise(r => setTimeout(r, 10));
      
      // Find and approve the confirmation
      const pending = policy.getPendingConfirmations();
      expect(pending.length).toBe(1);
      
      policy.handleUserResponse(pending[0]!.id, "approve");
      
      const result = await requestPromise;
      expect(result.approved).toBe(true);
    });
  });

  describe("handleUserResponse", () => {
    it("should handle approve response", async () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      const diff = createMockFileDiff();

      const requestPromise = policy.requestApproval("chat1", "user1", diff, "test op");
      await new Promise(r => setTimeout(r, 10));

      const pending = policy.getPendingConfirmations();
      const handled = policy.handleUserResponse(pending[0]!.id, "yes");
      
      expect(handled).toBe(true);
      const result = await requestPromise;
      expect(result.approved).toBe(true);
      expect(result.action).toBe("approve");
    });

    it("should handle reject response", async () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      const diff = createMockFileDiff();

      const requestPromise = policy.requestApproval("chat1", "user1", diff, "test op");
      await new Promise(r => setTimeout(r, 10));

      const pending = policy.getPendingConfirmations();
      policy.handleUserResponse(pending[0]!.id, "no");
      
      const result = await requestPromise;
      expect(result.approved).toBe(false);
      expect(result.action).toBe("reject");
    });

    it("should handle unknown confirmation ID", () => {
      const handled = policy.handleUserResponse("nonexistent", "yes");
      expect(handled).toBe(false);
    });

    it("should handle view_full action", async () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      const diff = createMockFileDiff();

      policy.requestApproval("chat1", "user1", diff, "test op");
      await new Promise(r => setTimeout(r, 10));

      const pending = policy.getPendingConfirmations();
      const handled = policy.handleUserResponse(pending[0]!.id, "view full");
      
      expect(handled).toBe(true);
      // Confirmation should still be pending
      expect(policy.getPendingConfirmations().length).toBe(1);
    });
  });

  describe("cancelConfirmation", () => {
    it("should cancel pending confirmation", async () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      const diff = createMockFileDiff();

      const requestPromise = policy.requestApproval("chat1", "user1", diff, "test op");
      await new Promise(r => setTimeout(r, 10));

      const pending = policy.getPendingConfirmations();
      const cancelled = policy.cancelConfirmation(pending[0]!.id, "Test cancel");
      
      expect(cancelled).toBe(true);
      const result = await requestPromise;
      expect(result.approved).toBe(false);
      expect(result.message).toBe("Test cancel");
    });

    it("should return false for unknown ID", () => {
      const cancelled = policy.cancelConfirmation("nonexistent");
      expect(cancelled).toBe(false);
    });
  });

  describe("cleanupExpiredPrefs", () => {
    it("should remove expired preferences", () => {
      const pastDate = new Date(Date.now() - 1000);
      policy.setSessionPrefs("user1", "chat1", { expiresAt: pastDate });
      policy.setSessionPrefs("user2", "chat1", { level: ApprovalLevel.ALWAYS }); // No expiry

      policy.cleanupExpiredPrefs();

      // user1 should be reset to defaults
      expect(policy.getSessionPrefs("user1", "chat1").level).toBe(ApprovalLevel.SMART);
      // user2 should keep their prefs
      expect(policy.getSessionPrefs("user2", "chat1").level).toBe(ApprovalLevel.ALWAYS);
    });
  });

  describe("resetSessionPrefs", () => {
    it("should reset preferences to defaults", () => {
      policy.setSessionPrefs("user1", "chat1", { level: ApprovalLevel.ALWAYS });
      policy.resetSessionPrefs("user1", "chat1");

      const prefs = policy.getSessionPrefs("user1", "chat1");
      expect(prefs.level).toBe(ApprovalLevel.SMART);
    });
  });
});

describe("isDestructiveOperation", () => {
  it("should identify file_delete as destructive", () => {
    expect(isDestructiveOperation("file_delete", { path: "test.ts" })).toBe(true);
  });

  it("should identify file_delete_directory as destructive", () => {
    expect(isDestructiveOperation("file_delete_directory", { path: "folder" })).toBe(true);
  });

  it("should identify file_write as destructive (can overwrite)", () => {
    expect(isDestructiveOperation("file_write", { path: "test.ts" })).toBe(true);
  });

  it("should identify dangerous shell commands as destructive", () => {
    expect(isDestructiveOperation("shell_exec", { command: "rm -rf /" })).toBe(true);
    expect(isDestructiveOperation("shell_exec", { command: "del file.txt" })).toBe(true);
    expect(isDestructiveOperation("shell_exec", { command: "format C:" })).toBe(true);
    expect(isDestructiveOperation("shell_exec", { command: "dd if=/dev/zero" })).toBe(true);
    expect(isDestructiveOperation("shell_exec", { command: "shutdown now" })).toBe(true);
  });

  it("should identify safe shell commands as non-destructive", () => {
    expect(isDestructiveOperation("shell_exec", { command: "ls -la" })).toBe(false);
    expect(isDestructiveOperation("shell_exec", { command: "echo hello" })).toBe(false);
    expect(isDestructiveOperation("shell_exec", { command: "cat file.txt" })).toBe(false);
  });

  it("should identify git_push as destructive", () => {
    expect(isDestructiveOperation("git_push", {})).toBe(true);
  });

  it("should identify git_reset as destructive", () => {
    expect(isDestructiveOperation("git_reset", {})).toBe(true);
  });

  it("should identify file_read as non-destructive", () => {
    expect(isDestructiveOperation("file_read", { path: "test.ts" })).toBe(false);
  });

  it("should identify file_edit as non-destructive", () => {
    expect(isDestructiveOperation("file_edit", { path: "test.ts" })).toBe(false);
  });
});

describe("createDMPolicy", () => {
  it("should create policy with default config", () => {
    const channel = createMockChannel();
    const policy = createDMPolicy(channel);

    expect(policy).toBeInstanceOf(DMPolicy);
  });

  it("should create policy with custom config", () => {
    const channel = createMockChannel();
    const config: Partial<DMPolicyConfig> = {
      defaultLevel: ApprovalLevel.ALWAYS,
      defaultTimeoutMs: 60000,
    };
    const policy = createDMPolicy(channel, config);

    expect(policy).toBeInstanceOf(DMPolicy);
  });
});
