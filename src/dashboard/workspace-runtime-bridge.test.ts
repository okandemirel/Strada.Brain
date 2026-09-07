/**
 * A goal node's own output reaches its row.
 *
 * Measured 2026-09-07: 215 of 215 goal nodes marked completed in goals.db had
 * result="" — among them "Obtain or generate non-placeholder art for every
 * identified entry-scene…", completed, with nothing to show what was obtained.
 * The bridge wrote the row's previous (empty) result because the event never
 * carried the worker's output.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createWorkspaceRuntimeBridge } from "./workspace-runtime-bridge.js";
import type { WorkspaceBus } from "./workspace-bus.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import type { TaskManager } from "../tasks/task-manager.js";

function harness() {
  const bus = new EventEmitter() as unknown as WorkspaceBus;
  const node = { id: "node-1", result: "", error: undefined, retryCount: 0, redecompositionCount: 0, reviewStatus: "none", reviewIterations: 0 };
  const updateNodeStatus = vi.fn();
  const goalStorage = {
    getTree: vi.fn(() => ({ nodes: new Map([["node-1", node]]) })),
    updateNodeStatus,
  } as unknown as GoalStorage;
  const bridge = createWorkspaceRuntimeBridge({ workspaceBus: bus, goalStorage, taskManager: {} as TaskManager });
  bridge.start();
  return { bus, updateNodeStatus };
}

describe("workspace runtime bridge keeps a completed node's output", () => {
  it("persists the output the event carries", () => {
    const { bus, updateNodeStatus } = harness();
    (bus as unknown as EventEmitter).emit("monitor:task_update", {
      rootId: "root-1",
      nodeId: "node-1",
      status: "completed",
      output: "Generated 3 sprites under Assets/Art/Pigs (provider local).",
    });
    expect(updateNodeStatus).toHaveBeenCalledTimes(1);
    expect(updateNodeStatus.mock.calls[0]?.[2]).toBe("Generated 3 sprites under Assets/Art/Pigs (provider local).");
  });

  it("keeps the row's existing result when the event carries none", () => {
    const { bus, updateNodeStatus } = harness();
    (bus as unknown as EventEmitter).emit("monitor:task_update", { rootId: "root-1", nodeId: "node-1", status: "executing" });
    expect(updateNodeStatus.mock.calls[0]?.[2]).toBe("");
  });
});
