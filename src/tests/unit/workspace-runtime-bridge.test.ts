import { beforeEach, describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../../core/event-bus.js";
import type { WorkspaceEventMap } from "../../dashboard/workspace-events.js";
import { createWorkspaceRuntimeBridge } from "../../dashboard/workspace-runtime-bridge.js";

function makeWorkspaceBus() {
  return new TypedEventBus<WorkspaceEventMap>();
}

describe("createWorkspaceRuntimeBridge", () => {
  let workspaceBus: TypedEventBus<WorkspaceEventMap>;

  beforeEach(() => {
    workspaceBus = makeWorkspaceBus();
  });

  it("persists monitor task updates into goal storage", () => {
    const goalStorage = {
      getTree: vi.fn().mockReturnValue({
        nodes: new Map([
          ["node-1", {
            id: "node-1",
            result: "checkpoint",
            error: undefined,
            retryCount: 2,
            redecompositionCount: 1,
          }],
        ]),
      }),
      updateNodeStatus: vi.fn(),
    } as any;
    const taskManager = {
      retryGoalRoot: vi.fn(),
      retryTask: vi.fn(),
      resumeGoalRoot: vi.fn(),
      resumeTask: vi.fn(),
      cancelGoalRoot: vi.fn(),
      cancel: vi.fn(),
    } as any;

    const bridge = createWorkspaceRuntimeBridge({ workspaceBus, goalStorage, taskManager });
    bridge.start();

    workspaceBus.emit("monitor:task_update", {
      rootId: "root-1",
      nodeId: "node-1",
      status: "executing",
    });

    expect(goalStorage.updateNodeStatus).toHaveBeenCalledWith(
      "node-1",
      "executing",
      "checkpoint",
      undefined,
      2,
      1,
    );
  });

  it("routes retry and resume commands through TaskManager and emits notifications", () => {
    const received: Array<{ title: string; message: string; severity: string }> = [];
    const taskManager = {
      retryGoalRoot: vi.fn(),
      retryTask: vi.fn().mockReturnValue({ id: "task_retry" }),
      resumeGoalRoot: vi.fn(),
      resumeTask: vi.fn().mockReturnValue({ id: "task_resume" }),
      cancelGoalRoot: vi.fn(),
      cancel: vi.fn(),
    } as any;

    workspaceBus.on("workspace:notification", (payload) => {
      received.push(payload as { title: string; message: string; severity: string });
    });

    const bridge = createWorkspaceRuntimeBridge({ workspaceBus, taskManager });
    bridge.start();

    workspaceBus.emit("monitor:retry_task", { taskId: "task-old", rootId: "root-1", nodeId: "node-2" });
    workspaceBus.emit("monitor:resume_task", { taskId: "task-old", rootId: "root-1" });

    expect(taskManager.retryTask).toHaveBeenCalledWith("task-old");
    expect(taskManager.resumeTask).toHaveBeenCalledWith("task-old");
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Retry queued", severity: "info" }),
      expect.objectContaining({ title: "Resume queued", severity: "info" }),
    ]));
  });

  it("routes cancel commands through TaskManager and prefers task attempts when provided", () => {
    const taskManager = {
      retryGoalRoot: vi.fn(),
      retryTask: vi.fn(),
      resumeGoalRoot: vi.fn(),
      resumeTask: vi.fn(),
      cancelGoalRoot: vi.fn().mockReturnValue(true),
      cancel: vi.fn().mockReturnValue(true),
    } as any;
    const bridge = createWorkspaceRuntimeBridge({ workspaceBus, taskManager });
    bridge.start();

    workspaceBus.emit("monitor:cancel_task", { rootId: "root-1", taskId: "task-active" });

    expect(taskManager.cancel).toHaveBeenCalledWith("task-active");
    expect(taskManager.cancelGoalRoot).not.toHaveBeenCalled();

    workspaceBus.emit("monitor:cancel_task", { rootId: "root-1" });

    expect(taskManager.cancelGoalRoot).toHaveBeenCalledWith("root-1");
  });
});
