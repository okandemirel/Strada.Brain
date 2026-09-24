/**
 * ORC-14 — /retry resubmits the most recent blocked task in the chat. In a shared channel that
 * can be another member's task; resubmitBlockedTask failed it and reran its prompt under the
 * owner's identity (autonomy prefs, memory scope, provider pins). It now enforces ownership the
 * way continueFromCheckpoint does for checkpoints.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));
vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

const { Orchestrator } = await import("./orchestrator.js");

function harness(ownerUserId: string | undefined) {
  const provider = {
    name: "mock",
    capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
    chat: vi.fn(),
  };
  const orch = new Orchestrator({
    providerManager: {
      getProvider: vi.fn(() => provider),
      getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
      shutdown: vi.fn(),
    },
    tools: [],
    channel: { name: "mock", connect: vi.fn(), disconnect: vi.fn(), onMessage: vi.fn(), sendText: vi.fn(), sendMarkdown: vi.fn(), isHealthy: () => true },
    projectPath: "/tmp/retry-ownership-project",
    readOnly: false,
    requireConfirmation: false,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  const taskManager = {
    getStatus: vi.fn(() => ({
      id: "task-1",
      status: "blocked",
      prompt: "deploy the build to production",
      chatId: "shared-channel",
      channelType: "discord",
      userId: ownerUserId,
    })),
    fail: vi.fn(),
  };
  orch.setTaskManager(taskManager as never);
  const handleMessage = vi.spyOn(orch, "handleMessage").mockResolvedValue(undefined);
  return { orch, taskManager, handleMessage };
}

describe("resubmitBlockedTask enforces the task owner (ORC-14)", () => {
  it("another user's /retry is refused and the owner's task is untouched", async () => {
    const h = harness("user-A");
    const result = await h.orch.resubmitBlockedTask("task-1", { userId: "user-B" });
    expect(result).toEqual({ status: "error", reason: "user_mismatch" });
    expect(h.taskManager.fail).not.toHaveBeenCalled();
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it("the owner's own /retry resubmits", async () => {
    const h = harness("user-A");
    const result = await h.orch.resubmitBlockedTask("task-1", { userId: "user-A" });
    expect(result.status).toBe("submitted");
    expect(h.taskManager.fail).toHaveBeenCalledTimes(1);
    expect(h.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-A", text: "deploy the build to production" }));
  });

  it("a task with no recorded owner stays retryable (legacy rows)", async () => {
    const h = harness(undefined);
    const result = await h.orch.resubmitBlockedTask("task-1", { userId: "user-B" });
    expect(result.status).toBe("submitted");
  });
});
