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
import { TypedEventBus } from "../core/event-bus.js";
import type { WorkspaceEventMap } from "./workspace-events.js";
import { createMonitorLifecycle } from "./monitor-lifecycle.js";
import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

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

/**
 * WEB-8 (server half): a Kanban move on a decomposed goal's board is sent with
 * the monitor EPISODE id as its rootId, because monitor-lifecycle re-roots the
 * goal tree under the episode. Goal storage only knows the goal root, so the
 * move was dropped and the card only snapped back after the portal's timeout.
 */
describe("workspace runtime bridge applies moves made on an episode board", () => {
  function episodeHarness() {
    const bus = new TypedEventBus<WorkspaceEventMap>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    for (const event of ["monitor:dag_init", "monitor:task_update", "workspace:notification"]) {
      bus.on(event, (payload: unknown) => emitted.push({ event, payload }));
    }
    const now = Date.now();
    const goalRoot = "goal_root_1" as GoalNodeId;
    const step = "goal_step_1" as GoalNodeId;
    const nodes = new Map<GoalNodeId, GoalNode>([
      [goalRoot, { id: goalRoot, parentId: null, task: "Root", dependsOn: [], depth: 0, status: "executing", createdAt: now, updatedAt: now }],
      [step, { id: step, parentId: goalRoot, task: "Step", dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now }],
    ]);
    const tree: GoalTree = { rootId: goalRoot, sessionId: "s", taskDescription: "Goal", nodes, createdAt: now };
    const updateNodeStatus = vi.fn();
    const goalStorage = {
      getTree: vi.fn((id: string) => (id === goalRoot ? tree : null)),
      updateNodeStatus,
    } as unknown as GoalStorage;
    const bridge = createWorkspaceRuntimeBridge({ workspaceBus: bus, goalStorage, taskManager: {} as TaskManager });
    bridge.start();
    const lifecycle = createMonitorLifecycle(bus);
    lifecycle.requestStart("scope-1", "build the thing");
    lifecycle.goalDecomposed("scope-1", tree);
    const board = emitted.filter((e) => e.event === "monitor:dag_init").at(-1)!.payload as { rootId: string };
    emitted.length = 0;
    return { bus, emitted, updateNodeStatus, episodeId: board.rootId, step };
  }

  it("maps the episode id to the goal tree, applies the move and confirms it on the board", () => {
    const { bus, emitted, updateNodeStatus, episodeId, step } = episodeHarness();
    expect(episodeId.startsWith("ep-")).toBe(true);

    bus.emit("monitor:move_task", { rootId: episodeId, taskId: step, nodeId: step, newStatus: "completed", toColumn: "done" });

    expect(updateNodeStatus).toHaveBeenCalledTimes(1);
    expect(updateNodeStatus.mock.calls[0]?.[0]).toBe(step);
    expect(updateNodeStatus.mock.calls[0]?.[1]).toBe("completed");
    const confirm = emitted.find((e) => e.event === "monitor:task_update");
    expect(confirm?.payload).toMatchObject({ rootId: episodeId, nodeId: step, status: "completed" });
  });

  it("refuses a node that is not on that board's goal tree, and says so", () => {
    const { bus, emitted, updateNodeStatus, episodeId } = episodeHarness();

    bus.emit("monitor:move_task", { rootId: episodeId, taskId: "step-0", nodeId: "step-0", newStatus: "completed" });

    expect(updateNodeStatus).not.toHaveBeenCalled();
    expect(emitted.some((e) => e.event === "monitor:task_update")).toBe(false);
    expect(emitted.find((e) => e.event === "workspace:notification")?.payload).toMatchObject({ severity: "warning" });
  });
});
