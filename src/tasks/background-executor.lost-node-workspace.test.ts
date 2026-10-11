/**
 * tasks-supervisor#4 through the REAL engine: a supervisor node whose own
 * worktree vanished is stopped by the lost-workspace reaper, and that stop
 * must settle the node as failed.
 *
 * Why this lives apart from background-executor.test.ts: that file
 * factory-mocks the runner module, and its fake resolved "failed" on abort —
 * which the V2 runner never does. The real runner stamps ANY abort of its
 * external signal as {kind:"user-cancel"}, a benign stop that keeps
 * "completed" in supervisor-node mode; the lease commit then finds an empty
 * directory, judgePublication sees no loss, and the bridge reported the node
 * "ok" with artifacts that never landed. Here nothing below the provider is a
 * stand-in: the real Orchestrator port, control plane, gateway and
 * V2AgentRunner, driven through createSupervisorExecuteNodeBridge exactly as
 * the supervisor dispatches a node.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../agent-core/control/clock.js";
import type { ProviderResponse } from "../agents/providers/provider-core.interface.js";

const loggerStub = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  getLogger: () => loggerStub,
  getLoggerSafe: () => loggerStub,
  getLogRingBuffer: () => [],
}));
// The Orchestrator boots without a real project (same stub as the V2 integration test).
vi.mock("../agents/context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: (p: { projectPath: string }) => ({
    content: `root=${p.projectPath}`,
    contentHashes: [p.projectPath],
    summary: `root=${p.projectPath}`,
    fingerprint: `root ${p.projectPath}`,
  }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

// Imported AFTER the mocks are registered.
const { Orchestrator } = await import("../agents/orchestrator.js");
const { BackgroundExecutor } = await import("./background-executor.js");
const { createSupervisorExecuteNodeBridge } = await import("../core/bootstrap.js");
const { WorkspaceLeaseManager } = await import("../agents/multi/workspace-lease-manager.js");

function resp(over: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ...over,
  } as ProviderResponse;
}

/** Pump the event loop and the injected FakeClock until the promise settles. */
async function drive<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = promise.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 2000 && !settled; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(1000);
  }
  return wrapped;
}

describe("BackgroundExecutor - a reaped supervisor node settles failed on the real V2 runner (tasks-supervisor#4)", () => {
  it("reports the node failed with the reap reason, not ok with artifacts that never landed", async () => {
    const leaseDir = mkdtempSync(join(tmpdir(), "node-lease-reaped-"));
    const clock = new FakeClock(0);
    const editTool = {
      name: "edit_file",
      description: "Mock edit_file",
      inputSchema: { type: "object", properties: {} },
      isWrite: true,
      execute: vi.fn().mockResolvedValue({
        content: "edit_file result",
        metadata: { touchedFiles: ["Assets/LevelSelect.cs"] },
      }),
    };
    let reap: () => void = () => {};
    const provider = {
      name: "mock",
      capabilities: {
        maxTokens: 4096, streaming: false, structuredStreaming: false,
        toolCalling: true, vision: false, systemPrompt: true,
      },
      chat: vi.fn(async () => {
        const call = provider.chat.mock.calls.length;
        if (call === 1) return resp({ text: "the plan", stopReason: "end_turn" });
        if (call === 2) {
          return resp({
            text: "",
            stopReason: "tool_use",
            toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "Assets/LevelSelect.cs" } }],
          });
        }
        // The node's worktree is deleted under it and the reaper's tick finds
        // it gone mid-call; the provider then rejects on its tripped signal.
        rmSync(leaseDir, { recursive: true, force: true });
        reap();
        throw new Error("This operation was aborted");
      }),
    };
    const orchestrator = new Orchestrator({
      providerManager: {
        getProvider: vi.fn(() => provider),
        getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
        shutdown: vi.fn(),
      },
      tools: [editTool],
      channel: {
        name: "mock",
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
        sendText: vi.fn().mockResolvedValue(undefined),
        sendMarkdown: vi.fn().mockResolvedValue(undefined),
        sendVisibleAssistantMarkdown: vi.fn().mockResolvedValue(undefined),
        sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
        requestConfirmation: vi.fn().mockResolvedValue("Yes"),
        isHealthy: vi.fn().mockReturnValue(true),
      },
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      agentCoreClock: clock,
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

    // An empty commit: the reap alone must fail the node, whatever publication says.
    const commit = vi.fn().mockResolvedValue({
      written: [], conflicts: [], removed: [], deleted: [], failed: [],
      conflictsQuarantinedUnder: null, quarantined: 0,
    });
    const executor = new BackgroundExecutor({
      orchestrator,
      workspaceLeaseManager: {
        acquireLease: vi.fn().mockResolvedValue({
          id: "lease-node", path: leaseDir, commit, release: vi.fn().mockResolvedValue(undefined),
        }),
      } as any,
    });
    const taskManager = {
      updateStatus: vi.fn(), complete: vi.fn(), fail: vi.fn(), block: vi.fn(),
      appendTaskNotice: vi.fn(), retryTask: vi.fn(),
      getStatus: vi.fn(() => null), listTasks: vi.fn(() => []), listStuckExecuting: vi.fn(() => []),
    };
    executor.setTaskManager(taskManager as any);
    reap = () => (executor as unknown as { reapLostWorkspaces(): void }).reapLostWorkspaces();

    const bridge = createSupervisorExecuteNodeBridge({ backgroundExecutor: executor, orchestrator });
    const supervisorSignal = new AbortController().signal;

    try {
      const node = await drive(clock, bridge(
        { id: "node_y", task: "Build the level select screen", dependsOn: [] } as any,
        { chatId: "chat-node", taskRunId: "task_x", nodeWorkspaces: "per-node" } as any,
        supervisorSignal,
      ));

      // Premise: the run really reached the reap — the node wrote, then lost its worktree.
      expect(editTool.execute).toHaveBeenCalledTimes(1);
      expect(provider.chat.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(node.status).toBe("failed");
      expect(node.output).toContain("workspace directory is gone");
      // The node is stopped, not its supervisor, and no task row is failed by the node's run id.
      expect(supervisorSignal.aborted).toBe(false);
      expect(taskManager.fail).not.toHaveBeenCalled();
    } finally {
      rmSync(leaseDir, { recursive: true, force: true });
      await executor.shutdown();
    }
  }, 30_000);
});

describe("BackgroundExecutor - a node whose worktree vanished before the reaper's tick does not settle ok", () => {
  it("fails the node when its workspace is gone at commit, with no reap having happened", async () => {
    // The reaper ticks every 5 minutes. A node whose directory went away
    // during its last turn and that finished before the next tick was never
    // reaped: the commit of the missing directory came back empty, which
    // reads as "nothing to publish", and the node settled ok with a write
    // that never reached the project. Real lease manager, real commit.
    const project = mkdtempSync(join(tmpdir(), "node-vanished-project-"));
    const leaseRoot = mkdtempSync(join(tmpdir(), "node-vanished-leases-"));
    mkdirSync(join(project, "Assets"), { recursive: true });
    writeFileSync(join(project, "Assets", "Board.cs"), "class Board {}");
    const clock = new FakeClock(0);
    let leasePath = "";
    const editTool = {
      name: "edit_file",
      description: "Mock edit_file",
      inputSchema: { type: "object", properties: {} },
      isWrite: true,
      execute: vi.fn(async () => {
        writeFileSync(join(leasePath, "Assets", "LevelSelect.cs"), "class LevelSelect {}");
        return { content: "edit_file result", metadata: { touchedFiles: ["Assets/LevelSelect.cs"] } };
      }),
    };
    const provider = {
      name: "mock",
      capabilities: {
        maxTokens: 4096, streaming: false, structuredStreaming: false,
        toolCalling: true, vision: false, systemPrompt: true,
      },
      chat: vi.fn(async () => {
        const call = provider.chat.mock.calls.length;
        if (call === 1) return resp({ text: "the plan", stopReason: "end_turn" });
        if (call === 2) {
          return resp({
            text: "",
            stopReason: "tool_use",
            toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "Assets/LevelSelect.cs" } }],
          });
        }
        // The worktree goes away during the summary turn; nobody reaps it.
        rmSync(leasePath, { recursive: true, force: true });
        return resp({ text: "Level select screen is built.", stopReason: "end_turn" });
      }),
    };
    const orchestrator = new Orchestrator({
      providerManager: {
        getProvider: vi.fn(() => provider),
        getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
        shutdown: vi.fn(),
      },
      tools: [editTool],
      channel: {
        name: "mock",
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
        sendText: vi.fn().mockResolvedValue(undefined),
        sendMarkdown: vi.fn().mockResolvedValue(undefined),
        sendVisibleAssistantMarkdown: vi.fn().mockResolvedValue(undefined),
        sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
        requestConfirmation: vi.fn().mockResolvedValue("Yes"),
        isHealthy: vi.fn().mockReturnValue(true),
      },
      projectPath: project,
      readOnly: false,
      requireConfirmation: false,
      agentCoreClock: clock,
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

    const leases = new WorkspaceLeaseManager({ projectRoot: project, leaseRoot, preferGitWorktree: false });
    const executor = new BackgroundExecutor({
      orchestrator,
      workspaceLeaseManager: {
        acquireLease: async (opts: Parameters<typeof leases.acquireLease>[0]) => {
          const lease = await leases.acquireLease(opts);
          leasePath = lease.path;
          return lease;
        },
      } as any,
    });
    const taskManager = {
      updateStatus: vi.fn(), complete: vi.fn(), fail: vi.fn(), block: vi.fn(),
      appendTaskNotice: vi.fn(), retryTask: vi.fn(),
      getStatus: vi.fn(() => null), listTasks: vi.fn(() => []), listStuckExecuting: vi.fn(() => []),
    };
    executor.setTaskManager(taskManager as any);
    const bridge = createSupervisorExecuteNodeBridge({ backgroundExecutor: executor, orchestrator });

    try {
      const node = await drive(clock, bridge(
        { id: "node_z", task: "Build the level select screen", dependsOn: [] } as any,
        { chatId: "chat-node-z", taskRunId: "task_z", nodeWorkspaces: "per-node" } as any,
        new AbortController().signal,
      ));

      // Premise: the node wrote into its worktree, then lost it — and no reap ran.
      expect(editTool.execute).toHaveBeenCalledTimes(1);
      expect(loggerStub.warn).not.toHaveBeenCalledWith("Reaping run whose workspace vanished", expect.anything());
      expect(node.status).toBe("failed");
      expect(node.output).toContain("no longer exists");
    } finally {
      await executor.shutdown();
      await leases.dispose();
      rmSync(project, { recursive: true, force: true });
      rmSync(leaseRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
