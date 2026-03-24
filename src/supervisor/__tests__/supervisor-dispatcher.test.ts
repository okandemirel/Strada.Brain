import { describe, it, expect, vi } from "vitest";
import { SupervisorDispatcher } from "../supervisor-dispatcher.js";
import type { TaggedGoalNode, NodeResult } from "../supervisor-types.js";

function makeAssignedNode(id: string, task: string, provider: string, deps: string[] = []): TaggedGoalNode {
  return {
    id: id as any, parentId: null, task, dependsOn: deps as any[],
    depth: 0, status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
    capabilityProfile: { primary: ["code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" },
    assignedProvider: provider, assignedModel: "test-model",
  };
}

function makeOkResult(nodeId: string, provider = "claude"): NodeResult {
  return { nodeId: nodeId as any, status: "ok", output: "done", artifacts: [], toolResults: [], provider, model: "test", cost: 0.001, duration: 100 };
}

describe("SupervisorDispatcher", () => {
  it("computes correct wave order from DAG", () => {
    const nodes = [
      makeAssignedNode("A", "Task A", "claude"),
      makeAssignedNode("B", "Task B", "deepseek"),
      makeAssignedNode("C", "Task C", "claude", ["A", "B"]),
    ];
    const dispatcher = new SupervisorDispatcher({
      executeNode: vi.fn(),
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const waves = dispatcher.computeWaves(nodes);
    expect(waves).toHaveLength(2);
    expect(waves[0].map(n => n.id)).toEqual(expect.arrayContaining(["A", "B"] as any[]));
    expect(waves[1].map(n => n.id)).toEqual(["C"]);
  });

  it("executes waves sequentially, nodes in parallel", async () => {
    const executionOrder: string[] = [];
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      executionOrder.push(node.id);
      return makeOkResult(node.id, node.assignedProvider!);
    });

    const nodes = [
      makeAssignedNode("A", "Task A", "claude"),
      makeAssignedNode("B", "Task B", "deepseek"),
      makeAssignedNode("C", "Task C", "groq", ["A", "B"]),
    ];

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);
    expect(results).toHaveLength(3);
    expect(results.filter(r => r.status === "ok")).toHaveLength(3);
    // C must execute after A and B
    expect(executionOrder.indexOf("C" as any)).toBeGreaterThan(executionOrder.indexOf("A" as any));
    expect(executionOrder.indexOf("C" as any)).toBeGreaterThan(executionOrder.indexOf("B" as any));
  });

  it("respects failure budget", async () => {
    const executeNode = vi.fn().mockResolvedValue({
      ...makeOkResult("X"), status: "failed",
    });

    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeAssignedNode(`N${i}`, `Task ${i}`, "claude"));

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);
    const failed = results.filter(r => r.status === "failed");
    expect(failed.length).toBeLessThanOrEqual(3);
  });

  it("handles timeout", async () => {
    const executeNode = vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(makeOkResult("X")), 10000))
    );

    const nodes = [makeAssignedNode("X", "Slow task", "claude")];
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 100, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);
    expect(results[0].status).toBe("failed");
  });

  it("supports external abort signal", async () => {
    const controller = new AbortController();
    const executeNode = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      return makeOkResult("X");
    });

    const nodes = [makeAssignedNode("X", "Task", "claude")];
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 60000, maxFailureBudget: 3 },
    });

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);
    const results = await dispatcher.dispatch(nodes, controller.signal);
    expect(results[0].status).toBe("failed");
  });

  it("retries once on transient failure (L1)", async () => {
    let attempts = 0;
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      attempts++;
      if (attempts === 1) throw new Error("ETIMEDOUT");
      return makeOkResult(node.id);
    });

    const nodes = [makeAssignedNode("A", "Task", "claude")];
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);
    expect(results[0].status).toBe("ok");
    expect(attempts).toBe(2); // 1 fail + 1 retry
  });

  it("skips dependent nodes when dependency fails", async () => {
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      if (node.id === "A") return { ...makeOkResult("A"), status: "failed" as const };
      return makeOkResult(node.id);
    });

    const nodes = [
      makeAssignedNode("A", "Fails", "claude"),
      makeAssignedNode("B", "Depends on A", "claude", ["A"]),
    ];
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);
    expect(results.find(r => (r.nodeId as any) === "A")?.status).toBe("failed");
    expect(results.find(r => (r.nodeId as any) === "B")?.status).toBe("skipped");
  });
});
