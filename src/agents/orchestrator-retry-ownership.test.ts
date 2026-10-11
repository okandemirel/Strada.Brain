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

// /retry, /continue and the implicit resume rebuilt the request from the last
// routing the main orchestrator's handleMessage recorded for the chat. Channel
// traffic goes router → task → runner and never records one, so the resume ran
// as channel "web", userId = chatId and no conversation: on the web channel
// (chatId is the connection, the owner is the profile) and in any shared chat
// that is somebody else's profile, autonomy, memory scope and learning.
describe("continueFromCheckpoint resumes as the checkpoint's owner", () => {
  function resumeHarness(cp: Record<string, unknown>) {
    const h = harness(undefined);
    const store = {
      loadByTaskId: vi.fn(async () => cp),
      loadLatest: vi.fn(async () => cp),
      clear: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };
    h.orch.setTaskCheckpointStore(store as never);
    return { ...h, store };
  }
  const base = { timestamp: 1, stage: "provider_failed", lastUserMessage: "build the second level", touchedFiles: [] };

  it("replays a shared-channel checkpoint as its owner, on its channel", async () => {
    const h = resumeHarness({ ...base, taskId: "task-7", chatId: "shared-channel", userId: "user-A", channelType: "discord" });
    const result = await h.orch.continueFromCheckpoint("shared-channel", { taskId: "task-7", userId: "user-A" });
    expect(result.status).toBe("resumed");
    expect(h.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelType: "discord", chatId: "shared-channel", userId: "user-A", text: "build the second level",
    }));
  });

  it("keeps a web owner's profile and conversation, not the connection's chat id", async () => {
    const h = resumeHarness({
      ...base, taskId: "task-8", chatId: "conn-5b1d", userId: "profile-7", channelType: "web", conversationId: "profile-7",
    });
    await h.orch.continueFromCheckpoint("conn-5b1d", { taskId: "task-8", userId: "profile-7" });
    expect(h.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelType: "web", chatId: "conn-5b1d", userId: "profile-7", conversationId: "profile-7",
    }));
  });

  it("a checkpoint with no recorded owner resumes as the caller, not as the chat id", async () => {
    const h = resumeHarness({ ...base, taskId: "task-9", chatId: "shared-channel" });
    await h.orch.continueFromCheckpoint("shared-channel", { taskId: "task-9", userId: "user-B" });
    expect(h.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-B" }));
  });

  it("the orchestrator's checkpoint writers record where the owner was talking", async () => {
    const h = resumeHarness({});
    const writers = h.orch as unknown as {
      saveBudgetExceededCheckpoint(p: Record<string, unknown>): Promise<void>;
      saveRollingCheckpoint(p: Record<string, unknown>): Promise<void>;
    };
    const where = { channelType: "web", conversationId: "profile-7" };
    await writers.saveBudgetExceededCheckpoint({
      taskId: "task-1", chatId: "conn-5b1d", userId: "profile-7", lastUserMessage: "x", used: 1, budget: 2, ...where,
    });
    await writers.saveRollingCheckpoint({
      taskId: "task-1", chatId: "conn-5b1d", userId: "profile-7", lastUserMessage: "x", epoch: 1, ...where,
    });
    expect(h.store.save).toHaveBeenCalledTimes(2);
    for (const [cp] of h.store.save.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(cp).toMatchObject(where);
    }
  });
});
