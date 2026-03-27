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
        workspaceLease: expect.objectContaining({
          id: "lease-parent",
          path: "/tmp/parent-workspace",
        }),
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
