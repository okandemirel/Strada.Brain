/**
 * Node transitions keep the task's inactivity watchdog alive.
 *
 * The watchdog is re-armed by progress updates, and the supervisor path only
 * emits those at planning milestones — activation, goal decomposition, status
 * summaries. Between them a wave can run tools for twenty minutes without
 * producing one.
 *
 * Measured: "Task made no progress for 1200000ms" fired four seconds after a
 * tool call and two LLM calls, on a run that went on to deliver 53 files. The
 * task was working; nothing was telling the watchdog so.
 */

import { describe, it, expect, vi } from "vitest";
import { SupervisorDispatcher } from "./supervisor-dispatcher.js";
import type { TaggedGoalNode, NodeResult } from "./supervisor-types.js";

function node(id: string, dependsOn: string[] = []): TaggedGoalNode {
  return {
    id,
    task: `task ${id}`,
    dependsOn,
    status: "pending",
    assignedProvider: "mock",
  } as unknown as TaggedGoalNode;
}

function okResult(id: string): NodeResult {
  return { nodeId: id, status: "ok", output: `${id} done`, duration: 1 } as unknown as NodeResult;
}

describe("supervisor liveness", () => {
  it("pings on node transitions so a working wave is not judged idle", async () => {
    const onLiveness = vi.fn();
    const dispatcher = new SupervisorDispatcher({
      onLiveness,
      executeNode: async (n: TaggedGoalNode) => okResult(n.id),
      config: { maxParallelNodes: 2, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });

    await dispatcher.dispatch([node("A"), node("B", ["A"])]);

    // Each node reports at least an executing and a terminal transition, so a
    // multi-node wave produces several pings across its lifetime — which is the
    // point: the gaps between planning milestones get covered.
    expect(onLiveness.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("still pings when a node fails", async () => {
    // A failing wave is still a live one; losing liveness here would make a
    // retrying task look hung.
    const onLiveness = vi.fn();
    const dispatcher = new SupervisorDispatcher({
      onLiveness,
      executeNode: async (n: TaggedGoalNode) =>
        ({ nodeId: n.id, status: "failed", output: "", duration: 1 }) as unknown as NodeResult,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });

    await dispatcher.dispatch([node("A")]);
    expect(onLiveness).toHaveBeenCalled();
  });

  it("pings with no monitor attached — the path the watchdog actually kills", async () => {
    // The first version of this put the ping after `if (!this.rootId) return`,
    // so it only fired when the monitor UI was wired up. A background task runs
    // headless: no rootId, no pings, watchdog fires at 20 minutes on a task that
    // is working. The tests above already run without a rootId; this one says so
    // out loud, because it is the whole point.
    const withMonitor = vi.fn();
    const headless = vi.fn();

    for (const [hook, rootId] of [
      [withMonitor, "root-1"],
      [headless, undefined],
    ] as const) {
      const dispatcher = new SupervisorDispatcher({
        onLiveness: hook,
        ...(rootId ? { rootId } : {}),
        executeNode: async (n: TaggedGoalNode) => okResult(n.id),
        config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
      });
      await dispatcher.dispatch([node("A")]);
    }

    expect(headless.mock.calls.length).toBe(withMonitor.mock.calls.length);
    expect(headless).toHaveBeenCalled();
  });

  it("runs unchanged when no liveness hook is supplied", async () => {
    const dispatcher = new SupervisorDispatcher({
      executeNode: async (n: TaggedGoalNode) => okResult(n.id),
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });

    const results = await dispatcher.dispatch([node("A")]);
    expect(results).toHaveLength(1);
  });
});
