/**
 * N-2 — `/routing info` after a normal chat turn in multi-agent mode.
 *
 * Multi-agent is on by default, so a chat turn runs on the orchestrator the
 * AgentManager builds for that chat. Those orchestrators were built without
 * the process's ProviderRouter: the v2 spine never routed, never recorded a
 * routing decision or an execution trace, and `/routing info` (which reads the
 * shared router) answered "No routing decisions recorded yet." after every
 * turn. This drives a real turn through a real AgentManager-built Orchestrator
 * and then asks the real CommandHandler, over the same router.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentManager } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentBudgetTracker } from "./agent-budget-tracker.js";
import { TypedEventBus, type LearningEventMap } from "../../core/event-bus.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { ProviderRouter, type ProviderManagerRef } from "../../agent-core/routing/provider-router.js";
import { CommandHandler } from "../../tasks/command-handler.js";
import type { ProviderResponse } from "../providers/provider.interface.js";

vi.mock("../../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop, getLogRingBuffer: () => [] };
});

vi.mock("../context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

// Per-agent memory is not what this test is about; keep SQLite + HNSW out of it.
vi.mock("../../memory/unified/agentdb-memory.js", () => ({
  AgentDBMemory: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      shutdown: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      close: vi.fn().mockResolvedValue(undefined),
      getUserProfileStore: vi.fn().mockReturnValue(null),
      getStats: vi.fn(() => ({ totalEntries: 0 })),
    };
  }),
}));

const CAPABILITIES = {
  maxTokens: 4096,
  streaming: false,
  structuredStreaming: false,
  toolCalling: true,
  vision: false,
  systemPrompt: true,
  thinkingSupported: false,
};

function answerProvider(name: string) {
  return {
    name,
    capabilities: CAPABILITIES,
    chat: vi.fn(async (): Promise<ProviderResponse> => ({
      text: "hello",
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  };
}

describe("AgentManager chat turns reach the shared ProviderRouter (N-2)", () => {
  let db: Database.Database;
  let tmpDir: string;
  let daemonStorage: DaemonStorage;
  let eventBus: TypedEventBus<LearningEventMap>;
  let manager: AgentManager | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    tmpDir = mkdtempSync(join(tmpdir(), "agent-mgr-routing-"));
    daemonStorage = new DaemonStorage(join(tmpDir, "daemon.db"));
    daemonStorage.initialize();
    eventBus = new TypedEventBus<LearningEventMap>();
  });

  afterEach(async () => {
    await manager?.shutdown();
    await eventBus.shutdown();
    db.close();
    daemonStorage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a turn followed by /routing info lists the routing decision and the runtime execution", async () => {
    const kimi = answerProvider("kimi");
    const qwen = answerProvider("qwen");
    const byName = (name: string) => (name === "qwen" ? qwen : name === "kimi" ? kimi : null);
    const providerManager = {
      getProvider: () => kimi,
      getProviderByName: byName,
      getPrimaryProviderByName: byName,
      // `/model kimi`: a soft preference, so the router still decides.
      getActiveInfo: () => ({ providerName: "kimi", model: "kimi-model", isDefault: false, selectionMode: "strada-preference-bias" }),
      listAvailable: () => [
        { name: "kimi", label: "Kimi", defaultModel: "kimi-model" },
        { name: "qwen", label: "Qwen", defaultModel: "qwen-model" },
      ],
      isAvailable: (name: string) => name === "kimi" || name === "qwen",
      shutdown: vi.fn(),
    };
    const router = new ProviderRouter(providerManager as unknown as ProviderManagerRef, "balanced");
    const registry = new AgentRegistry(db);
    registry.initialize();
    const budgetTracker = new AgentBudgetTracker(daemonStorage);
    budgetTracker.initialize();
    const channel = {
      name: "cli",
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
    };

    manager = new AgentManager({
      config: { enabled: true, defaultBudgetUsd: 5, maxConcurrent: 4, idleTimeoutMs: 60_000, maxMemoryEntries: 1000 },
      registry,
      budgetTracker,
      eventBus,
      providerManager: providerManager as never,
      toolRegistry: { getAllTools: () => [] },
      channel: channel as never,
      projectPath: join(tmpDir, "project"),
      readOnly: true,
      requireConfirmation: true,
      stradaDeps: { coreInstalled: true } as never,
      memoryConfig: { dimensions: 8, dbBasePath: tmpDir },
      providerRouter: router,
    });

    await manager.routeMessage({
      channelType: "cli",
      chatId: "cli-local",
      userId: "cli-user",
      text: "Say hello in one word.",
      timestamp: new Date(),
    });
    expect(kimi.chat.mock.calls.length + qwen.chat.mock.calls.length).toBeGreaterThan(0);

    const commands = new CommandHandler({} as never, channel as never, providerManager as never);
    commands.setProviderRouter(router);
    await commands.handle("cli-local", "routing", ["info"], "cli-user");

    expect(channel.sendText).not.toHaveBeenCalledWith("cli-local", "No routing decisions recorded yet.");
    const info = channel.sendMarkdown.mock.calls
      .map((call: unknown[]) => String(call[1]))
      .find((text: string) => text.includes("*Recent Routing Decisions*"));
    expect(info).toBeDefined();
    expect(info).toContain("*Recent Runtime Execution*");
    // Attributed to the identity the command reads (the user id, not the chat).
    expect(router.getRecentDecisions(10, "cli-user").length).toBeGreaterThan(0);
    expect(router.getRecentExecutionTraces(10, "cli-user").length).toBeGreaterThan(0);
  });
});
