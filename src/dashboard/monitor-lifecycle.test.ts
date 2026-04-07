import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMonitorLifecycle } from "./monitor-lifecycle.js";
import type { WorkspaceBus } from "./workspace-bus.js";
import type { GoalTree, GoalNode, GoalNodeId } from "../goals/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBus(): WorkspaceBus & { calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  return {
    calls,
    emit(event: string, payload: unknown) {
      calls.push({ event, payload });
    },
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceBus & { calls: Array<{ event: string; payload: unknown }> };
}

function makeGoalTree(overrides?: Partial<GoalTree>): GoalTree {
  const rootId = "goal_root" as GoalNodeId;
  const childId = "goal_child_1" as GoalNodeId;
  const now = Date.now();
  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, {
    id: rootId,
    parentId: null,
    task: "Root task",
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  nodes.set(childId, {
    id: childId,
    parentId: rootId,
    task: "Child task",
    dependsOn: [],
    depth: 1,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return {
    rootId,
    sessionId: "test-session",
    taskDescription: "Test goal tree",
    nodes,
    createdAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMonitorLifecycle", () => {
  let bus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    bus = createMockBus();
  });

  it("returns an object with the expected methods", () => {
    const lc = createMonitorLifecycle(bus);
    expect(typeof lc.requestStart).toBe("function");
    expect(typeof lc.goalDecomposed).toBe("function");
    expect(typeof lc.goalRestructured).toBe("function");
    expect(typeof lc.requestEnd).toBe("function");
  });

  // =========================================================================
  // requestStart
  // =========================================================================

  describe("requestStart", () => {
    it("emits a monitor:dag_init event with a single executing node", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "Hello world");

      expect(bus.calls).toHaveLength(1);
      const { event, payload } = bus.calls[0]!;
      expect(event).toBe("monitor:dag_init");

      const p = payload as { rootId: string; nodes: Array<Record<string, unknown>>; edges: unknown[] };
      expect(p.nodes).toHaveLength(1);
      expect(p.edges).toHaveLength(0);

      const node = p.nodes[0]!;
      expect(node.id).toBe(p.rootId);
      expect(node.status).toBe("executing");
      expect(node.reviewStatus).toBe("none");
      expect(node.depth).toBe(1);
      expect(node.dependsOn).toEqual([]);
    });

    it("generates task IDs matching the req-<timestamp>-<random> pattern", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");

      const p = bus.calls[0]!.payload as { rootId: string };
      expect(p.rootId).toMatch(/^req-\d+-[a-z0-9]{5}$/);
    });

    it("truncates messages longer than 200 characters and appends ellipsis", () => {
      const lc = createMonitorLifecycle(bus);
      const longMessage = "A".repeat(250);
      lc.requestStart("scope-1", longMessage);

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      const task = p.nodes[0]!.task;
      expect(task).toHaveLength(201); // 200 chars + 1 ellipsis char
      expect(task.endsWith("\u2026")).toBe(true);
      expect(task.startsWith("A")).toBe(true);
    });

    it("preserves messages exactly at the 200-character limit", () => {
      const lc = createMonitorLifecycle(bus);
      const exactMessage = "B".repeat(200);
      lc.requestStart("scope-1", exactMessage);

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      expect(p.nodes[0]!.task).toBe(exactMessage);
    });

    it("preserves short messages without truncation", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "Short msg");

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      expect(p.nodes[0]!.task).toBe("Short msg");
    });

    it("generates unique task IDs for consecutive calls on the same scope", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      lc.requestStart("scope-1", "second");

      const id1 = (bus.calls[0]!.payload as { rootId: string }).rootId;
      const id2 = (bus.calls[1]!.payload as { rootId: string }).rootId;
      expect(id1).not.toBe(id2);
    });
  });

  // =========================================================================
  // requestEnd
  // =========================================================================

  describe("requestEnd", () => {
    it("emits monitor:task_update with status completed on success", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const taskId = (bus.calls[0]!.payload as { rootId: string }).rootId;

      lc.requestEnd("scope-1");

      expect(bus.calls).toHaveLength(2);
      const { event, payload } = bus.calls[1]!;
      expect(event).toBe("monitor:task_update");
      expect(payload).toEqual({
        rootId: taskId,
        nodeId: taskId,
        status: "completed",
      });
    });

    it("emits monitor:task_update with status failed when failed=true", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const taskId = (bus.calls[0]!.payload as { rootId: string }).rootId;

      lc.requestEnd("scope-1", true);

      const { payload } = bus.calls[1]!;
      expect(payload).toEqual({
        rootId: taskId,
        nodeId: taskId,
        status: "failed",
      });
    });

    it("is a no-op when called without a prior requestStart", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestEnd("unknown-scope");

      expect(bus.calls).toHaveLength(0);
    });

    it("is a no-op on the second call (already cleaned up)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      lc.requestEnd("scope-1");
      lc.requestEnd("scope-1"); // second call

      // Only dag_init + one task_update
      expect(bus.calls).toHaveLength(2);
    });
  });

  // =========================================================================
  // goalDecomposed
  // =========================================================================

  describe("goalDecomposed", () => {
    it("emits monitor:dag_init with the converted goal tree payload", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const goalTree = makeGoalTree();

      lc.goalDecomposed("scope-1", goalTree);

      expect(bus.calls).toHaveLength(2);
      const { event, payload } = bus.calls[1]!;
      expect(event).toBe("monitor:dag_init");

      const p = payload as { rootId: string; nodes: unknown[]; edges: unknown[] };
      expect(p.rootId).toBe("goal_root");
      // goalTreeToDagPayload skips the root node, so only child is included
      expect(p.nodes).toHaveLength(1);
    });

    it("clears the simple task so requestEnd becomes a no-op", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      lc.goalDecomposed("scope-1", makeGoalTree());

      lc.requestEnd("scope-1"); // should be no-op

      // dag_init (requestStart) + dag_init (goalDecomposed), no task_update
      expect(bus.calls).toHaveLength(2);
      expect(bus.calls.every(c => c.event === "monitor:dag_init")).toBe(true);
    });

    it("works even without a prior requestStart", () => {
      const lc = createMonitorLifecycle(bus);
      lc.goalDecomposed("scope-1", makeGoalTree());

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0]!.event).toBe("monitor:dag_init");
    });
  });

  // =========================================================================
  // goalRestructured
  // =========================================================================

  describe("goalRestructured", () => {
    it("emits monitor:dag_restructure with the converted goal tree payload", () => {
      const lc = createMonitorLifecycle(bus);
      const goalTree = makeGoalTree();

      lc.goalRestructured("scope-1", goalTree);

      expect(bus.calls).toHaveLength(1);
      const { event, payload } = bus.calls[0]!;
      expect(event).toBe("monitor:dag_restructure");

      const p = payload as { rootId: string; nodes: unknown[] };
      expect(p.rootId).toBe("goal_root");
    });
  });

  // =========================================================================
  // Multiple concurrent scopes
  // =========================================================================

  describe("multiple concurrent scopes", () => {
    it("tracks lifecycles independently per scope", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-A", "msg A");
      lc.requestStart("scope-B", "msg B");

      const idA = (bus.calls[0]!.payload as { rootId: string }).rootId;
      const idB = (bus.calls[1]!.payload as { rootId: string }).rootId;
      expect(idA).not.toBe(idB);

      // End scope-A only
      lc.requestEnd("scope-A");

      expect(bus.calls).toHaveLength(3);
      const endPayload = bus.calls[2]!.payload as { rootId: string; status: string };
      expect(endPayload.rootId).toBe(idA);
      expect(endPayload.status).toBe("completed");

      // End scope-B separately
      lc.requestEnd("scope-B");
      const endPayloadB = bus.calls[3]!.payload as { rootId: string; status: string };
      expect(endPayloadB.rootId).toBe(idB);
    });

    it("goalDecomposed on one scope does not affect another", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-A", "msg A");
      lc.requestStart("scope-B", "msg B");

      const idB = (bus.calls[1]!.payload as { rootId: string }).rootId;

      // Decompose scope-A only
      lc.goalDecomposed("scope-A", makeGoalTree());

      // scope-A requestEnd should be no-op
      lc.requestEnd("scope-A");

      // scope-B requestEnd should still work
      lc.requestEnd("scope-B");
      const lastCall = bus.calls[bus.calls.length - 1]!;
      expect(lastCall.event).toBe("monitor:task_update");
      expect((lastCall.payload as { rootId: string }).rootId).toBe(idB);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("requestStart overwrites previous tracking for the same scope", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      lc.requestStart("scope-1", "second");

      const id2 = (bus.calls[1]!.payload as { rootId: string }).rootId;

      // requestEnd should use the second task ID
      lc.requestEnd("scope-1");
      const endPayload = bus.calls[2]!.payload as { rootId: string };
      expect(endPayload.rootId).toBe(id2);
    });

    it("handles empty string user message", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "");

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      expect(p.nodes[0]!.task).toBe("");
    });

    it("requestEnd with failed=false behaves like default (completed)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      lc.requestEnd("scope-1", false);

      const p = bus.calls[1]!.payload as { status: string };
      expect(p.status).toBe("completed");
    });
  });
});
