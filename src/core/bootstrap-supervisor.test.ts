import { describe, expect, it, vi } from "vitest";
import { createSupervisorExecuteNodeBridge, initializeWorkspaceRuntime } from "./bootstrap.js";

describe("createSupervisorExecuteNodeBridge", () => {
  it("derives child workspace context and remaps blocked workers", async () => {
    const runWorkerEnvelope = vi.fn().mockResolvedValue({
      output: "Need user input",
      workerResult: {
        status: "blocked",
        reason: "Need user input",
      },
    });

    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: {
        runWorkerEnvelope,
      } as any,
      orchestrator: {} as any,
      workspaceBus: {
        emit: vi.fn(),
      } as any,
      defaultChannelType: "cli",
    });

    const result = await bridge(
      {
        id: "node-1",
        task: "Inspect screenshot",
        assignedProvider: "claude",
        assignedModel: "sonnet",
      } as any,
      {
        chatId: "chat-1",
        taskRunId: "taskrun_parent",
        userContent: [
          { type: "text", text: "Inspect screenshot" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "cG5n" },
          },
        ],
        workspaceLease: {
          id: "lease-parent",
          path: "/tmp/parent-workspace",
        },
      } as any,
      new AbortController().signal,
    );

    expect(runWorkerEnvelope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "delegated",
        prompt: "Inspect screenshot",
        chatId: "chat-1",
        channelType: "cli",
        taskRunId: "taskrun_parent:node-1",
        assignedProvider: "claude",
        assignedModel: "sonnet",
        userContent: expect.any(Array),
        // Per-node CHILD lease: the bridge seeds from the parent's path
        // instead of handing the shared lease down, which is what let the
        // supervisor clamp parallelism to 1 (2026-09-01).
        workspaceSourceRoot: "/tmp/parent-workspace",
        signal: expect.any(AbortSignal),
        supervisorMode: "off",
      }),
    );
    expect(result).toMatchObject({
      nodeId: "node-1",
      status: "failed",
      output: "Need user input",
      blockedReason: "Need user input",
    });
  });

  it("stamps the parent goal's monitorScope onto the worker envelope (the run's whole-goal rollup scope)", async () => {
    // Producer-side proof that monitorScope is wired (no longer a write-only sink): the supervisor
    // bridge stamps the ORIGINATING request's resolveConversationScope onto the worker envelope —
    // the SAME scope the supervisor uses for its own dag_init/task_update. The downstream consumer
    // lives in Orchestrator.runBackgroundTask (joinEpisode/joinEpisodeEnd), gated exactly like
    // executeTask/processMessage on `monitorScope !== own conversationScope`.
    const runWorkerEnvelope = vi.fn().mockResolvedValue({
      output: "done",
      workerResult: { status: "completed", finalSummary: "done", touchedFiles: [] },
    });

    const bridge = createSupervisorExecuteNodeBridge({
      backgroundExecutor: { runWorkerEnvelope } as any,
      orchestrator: {} as any,
      workspaceBus: { emit: vi.fn() } as any,
      defaultChannelType: "cli",
    });

    // Parent request carries a distinct conversationId so the parent scope is that conversationId
    // (resolveConversationScope prefers conversationId over chatId) — proving the stamp is the
    // ORIGINATING request's scope, never a coarser/shared value or the worker's bare chatId.
    await bridge(
      { id: "node-9", task: "Sub-goal A" } as any,
      {
        chatId: "parent-chat",
        conversationId: "parent-conversation",
        taskRunId: "taskrun_parent",
      } as any,
      new AbortController().signal,
    );

    const envelope = runWorkerEnvelope.mock.calls[0]?.[1];
    // The parent scope (the conversationId) is stamped — NOT undefined (dormant) and NOT the
    // worker's bare chatId.
    expect(envelope.monitorScope).toBe("parent-conversation");
    // The bridge forwards the parent's identity verbatim, so the worker runs UNDER the parent's
    // own scope. The consumer therefore sees `monitorScope === own conversationScope` and
    // correctly SUPPRESSES a simple-card join — the supervisor already represents this sub-goal
    // as a DAG node, so the whole goal stays ONE monitor conversation without a stray card.
    expect(envelope.chatId).toBe("parent-chat");
    expect(envelope.conversationId).toBe("parent-conversation");
  });

  it("wires supervisor execution before channel startup completes", () => {
    const setWorkspaceBus = vi.fn();
    const setMonitorLifecycle = vi.fn();
    const setExecuteNode = vi.fn();
    const setEventEmitter = vi.fn();
    const setDashboardWorkspaceBus = vi.fn();
    const setAgentWorkspaceRuntime = vi.fn();

    const workspaceBus = initializeWorkspaceRuntime({
      channel: {},
      orchestrator: {
        setWorkspaceBus,
        setMonitorLifecycle,
      } as any,
      backgroundExecutor: {
        setWorkspaceBus,
        setMonitorLifecycle,
        runWorkerEnvelope: vi.fn(),
      } as any,
      supervisorBrain: {
        setExecuteNode,
        setEventEmitter,
      },
      dashboard: {
        setWorkspaceBus: setDashboardWorkspaceBus,
      },
      agentManager: {
        setWorkspaceRuntime: setAgentWorkspaceRuntime,
      },
      orchestratorForSupervisorBridge: {} as any,
      channelType: "cli",
      stoppableServers: [],
    });

    expect(setWorkspaceBus).toHaveBeenCalledTimes(2);
    expect(setMonitorLifecycle).toHaveBeenCalledTimes(2);
    expect(setExecuteNode).toHaveBeenCalledTimes(1);
    expect(setEventEmitter).toHaveBeenCalledWith(workspaceBus);
    expect(setDashboardWorkspaceBus).toHaveBeenCalledWith(workspaceBus);
    expect(setAgentWorkspaceRuntime).toHaveBeenCalledWith(workspaceBus, expect.anything());
  });
});
