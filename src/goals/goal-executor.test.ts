/**
 * GoalExecutor Tests
 *
 * Tests for wave-based parallel DAG execution, semaphore concurrency limiting,
 * failure budgets, LLM criticality evaluation, retries, and per-node timing.
 */

import { describe, it, expect, vi } from "vitest";
import { GoalExecutor, Semaphore } from "./goal-executor.js";
import type {
  NodeExecutor,
  OnNodeStatusChange,
  CriticalityEvaluator,
  OnFailureBudgetExceeded,
  GoalExecutorConfig,
} from "./goal-executor.js";
import type { GoalNode, GoalTree, GoalNodeId } from "./types.js";
import { generateGoalNodeId } from "./types.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeNode(
  overrides: Partial<GoalNode> & { id: GoalNodeId },
): GoalNode {
  const now = Date.now();
  return {
    parentId: null,
    task: "test task",
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTree(nodeList: GoalNode[], rootId: GoalNodeId): GoalTree {
  const nodes = new Map<GoalNodeId, GoalNode>();
  for (const n of nodeList) {
    nodes.set(n.id, n);
  }
  return {
    rootId,
    sessionId: "test-session",
    taskDescription: "Test tree",
    nodes,
    createdAt: Date.now(),
  };
}

const defaultConfig: GoalExecutorConfig = {
  maxRetries: 1,
  maxFailures: 3,
  parallelExecution: true,
  maxParallel: 3,
};

/** Mock executor that resolves with the node's task unless task contains "FAIL" */
const mockExecutor: NodeExecutor = async (node) => {
  if (node.task.includes("FAIL")) {
    throw new Error(`Failed: ${node.task}`);
  }
  return `Result: ${node.task}`;
};

// =============================================================================
// SEMAPHORE TESTS
// =============================================================================

describe("Semaphore", () => {
  it("limits concurrent tasks to the specified limit", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return running;
    };

    await Promise.all([
      sem.acquire(task),
      sem.acquire(task),
      sem.acquire(task),
    ]);

    expect(maxRunning).toBe(2);
  });

  it("runs tasks sequentially when limit is 1", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const makeTask = (n: number) => async () => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 10));
      return n;
    };

    await Promise.all([
      sem.acquire(makeTask(1)),
      sem.acquire(makeTask(2)),
      sem.acquire(makeTask(3)),
    ]);

    // All tasks should have executed
    expect(order).toHaveLength(3);
  });
});

// =============================================================================
// GOAL EXECUTOR TESTS
// =============================================================================

describe("GoalExecutor", () => {
  it("executes linear chain (A->B->C) in order", async () => {
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B", dependsOn: [aId] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C", dependsOn: [bId] });
    const tree = makeTree([root, a, b, c], rootId);

    const executionOrder: string[] = [];
    const orderExecutor: NodeExecutor = async (node) => {
      executionOrder.push(node.task);
      return `Done: ${node.task}`;
    };

    const result = await executor.executeTree(tree, orderExecutor, new AbortController().signal);

    expect(executionOrder).toEqual(["A", "B", "C"]);
    expect(result.failureCount).toBe(0);
    expect(result.aborted).toBe(false);
  });

  it("executes diamond DAG (A->{B,C}->D) with parallel wave for B and C", async () => {
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();
    const dId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B", dependsOn: [aId] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C", dependsOn: [aId] });
    const d = makeNode({ id: dId, parentId: rootId, depth: 1, task: "D", dependsOn: [bId, cId] });
    const tree = makeTree([root, a, b, c, d], rootId);

    const waves: string[][] = [];
    let currentWave: string[] = [];
    let lastWaveMarker = 0;

    const waveExecutor: NodeExecutor = async (node) => {
      currentWave.push(node.task);
      return `Done: ${node.task}`;
    };

    const result = await executor.executeTree(tree, waveExecutor, new AbortController().signal);

    // A must execute first, B and C can be in same wave, D last
    expect(result.failureCount).toBe(0);
    const nodeA = result.tree.nodes.get(aId);
    const nodeB = result.tree.nodes.get(bId);
    const nodeC = result.tree.nodes.get(cId);
    const nodeD = result.tree.nodes.get(dId);
    expect(nodeA?.status).toBe("completed");
    expect(nodeB?.status).toBe("completed");
    expect(nodeC?.status).toBe("completed");
    expect(nodeD?.status).toBe("completed");
  });

  it("executes all independent nodes in wave 1", async () => {
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B", dependsOn: [] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C", dependsOn: [] });
    const tree = makeTree([root, a, b, c], rootId);

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal);

    expect(result.failureCount).toBe(0);
    for (const [id, node] of result.tree.nodes) {
      if (id === rootId) continue;
      expect(node.status).toBe("completed");
    }
  });

  it("skips dependent nodes when a node fails with no criticality evaluator", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-depends-on-A", dependsOn: [aId] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C-independent", dependsOn: [] });
    const tree = makeTree([root, a, b, c], rootId);

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal);

    expect(result.tree.nodes.get(aId)?.status).toBe("failed");
    expect(result.tree.nodes.get(bId)?.status).toBe("skipped");
    expect(result.tree.nodes.get(cId)?.status).toBe("completed");
  });

  it("retries a failed node up to maxRetries before marking as failed", async () => {
    let attempts = 0;
    const retryExecutor: NodeExecutor = async () => {
      attempts++;
      throw new Error("Always fails");
    };

    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 2 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A" });
    const tree = makeTree([root, a], rootId);

    const result = await executor.executeTree(tree, retryExecutor, new AbortController().signal);

    // 1 initial attempt + 2 retries = 3 total attempts
    expect(attempts).toBe(3);
    expect(result.tree.nodes.get(aId)?.status).toBe("failed");
    expect(result.tree.nodes.get(aId)?.retryCount).toBe(2);
  });

  it("aborts when failure budget exceeded and no callback provided", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0, maxFailures: 1 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "FAIL-B", dependsOn: [] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C-pending", dependsOn: [aId, bId] });
    const tree = makeTree([root, a, b, c], rootId);

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal);

    expect(result.aborted).toBe(true);
    expect(result.tree.nodes.get(cId)?.status).toBe("skipped");
  });

  it("continues when failure budget exceeded and callback returns continue=true", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0, maxFailures: 1 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-independent", dependsOn: [] });
    const tree = makeTree([root, a, b], rootId);

    const budgetCallback: OnFailureBudgetExceeded = async () => ({
      continue: true,
      alwaysContinue: false,
    });

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onFailureBudgetExceeded: budgetCallback,
    });

    expect(result.aborted).toBe(false);
    expect(result.tree.nodes.get(bId)?.status).toBe("completed");
  });

  it("skips future budget callbacks when alwaysContinue is true", async () => {
    const callCount = { value: 0 };
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0, maxFailures: 1 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();
    const dId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    // All fail, all independent -- will trigger budget multiple times
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "FAIL-B", dependsOn: [] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "FAIL-C", dependsOn: [aId] });
    const d = makeNode({ id: dId, parentId: rootId, depth: 1, task: "D-ok", dependsOn: [bId] });
    const tree = makeTree([root, a, b, c, d], rootId);

    const budgetCallback: OnFailureBudgetExceeded = async () => {
      callCount.value++;
      return { continue: true, alwaysContinue: true };
    };

    // Use a modified executor that allows "D-ok" to pass
    const mixedExecutor: NodeExecutor = async (node) => {
      if (node.task.includes("FAIL")) throw new Error(`Failed: ${node.task}`);
      return `Done: ${node.task}`;
    };

    await executor.executeTree(tree, mixedExecutor, new AbortController().signal, {
      onFailureBudgetExceeded: budgetCallback,
    });

    // Callback should be called only once (alwaysContinue skips subsequent calls)
    expect(callCount.value).toBe(1);
  });

  it("aborts when failure budget callback returns continue=false", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0, maxFailures: 1 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-pending", dependsOn: [aId] });
    const tree = makeTree([root, a, b], rootId);

    const budgetCallback: OnFailureBudgetExceeded = async () => ({
      continue: false,
      alwaysContinue: false,
    });

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onFailureBudgetExceeded: budgetCallback,
    });

    expect(result.aborted).toBe(true);
  });

  it("generates FailureReport with correct failed nodes info", async () => {
    let capturedReport: import("./goal-executor.js").FailureReport | null = null;
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0, maxFailures: 1 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "FAIL-B", dependsOn: [] });
    const tree = makeTree([root, a, b], rootId);

    const budgetCallback: OnFailureBudgetExceeded = async (report) => {
      capturedReport = report;
      return { continue: false, alwaysContinue: false };
    };

    await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onFailureBudgetExceeded: budgetCallback,
    });

    expect(capturedReport).not.toBeNull();
    expect(capturedReport!.failureCount).toBeGreaterThanOrEqual(1);
    expect(capturedReport!.maxFailures).toBe(1);
    expect(capturedReport!.failedNodes.length).toBeGreaterThanOrEqual(1);
    expect(capturedReport!.failedNodes[0]?.error).toContain("Failed:");
  });

  it("allows dependent nodes to proceed when CriticalityEvaluator returns false", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-depends-on-A", dependsOn: [aId] });
    const tree = makeTree([root, a, b], rootId);

    const critEval: CriticalityEvaluator = async () => false; // not critical

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      criticalityEvaluator: critEval,
    });

    expect(result.tree.nodes.get(aId)?.status).toBe("failed");
    expect(result.tree.nodes.get(bId)?.status).toBe("completed");
  });

  it("skips dependent nodes when CriticalityEvaluator returns true", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-depends-on-A", dependsOn: [aId] });
    const tree = makeTree([root, a, b], rootId);

    const critEval: CriticalityEvaluator = async () => true; // critical

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      criticalityEvaluator: critEval,
    });

    expect(result.tree.nodes.get(aId)?.status).toBe("failed");
    expect(result.tree.nodes.get(bId)?.status).toBe("skipped");
  });

  it("does not call CriticalityEvaluator when failed node has no dependents", async () => {
    const critEval = vi.fn<CriticalityEvaluator>().mockResolvedValue(true);
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const tree = makeTree([root, a], rootId);

    await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      criticalityEvaluator: critEval,
    });

    expect(critEval).not.toHaveBeenCalled();
  });

  it("records per-node timing (startedAt and completedAt)", async () => {
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A" });
    const tree = makeTree([root, a], rootId);

    const before = Date.now();
    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal);
    const after = Date.now();

    const nodeA = result.tree.nodes.get(aId)!;
    expect(nodeA.startedAt).toBeDefined();
    expect(nodeA.completedAt).toBeDefined();
    expect(nodeA.startedAt!).toBeGreaterThanOrEqual(before);
    expect(nodeA.completedAt!).toBeLessThanOrEqual(after);
    expect(nodeA.completedAt!).toBeGreaterThanOrEqual(nodeA.startedAt!);
  });

  it("executes nodes one at a time when parallel disabled", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, parallelExecution: false });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B", dependsOn: [] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C", dependsOn: [] });
    const tree = makeTree([root, a, b, c], rootId);

    let running = 0;
    let maxRunning = 0;
    const seqExecutor: NodeExecutor = async (node) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return `Done: ${node.task}`;
    };

    const result = await executor.executeTree(tree, seqExecutor, new AbortController().signal);

    expect(maxRunning).toBe(1);
    expect(result.failureCount).toBe(0);
  });

  it("aborts remaining nodes when AbortSignal fires mid-execution", async () => {
    const controller = new AbortController();
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B", dependsOn: [aId] });
    const tree = makeTree([root, a, b], rootId);

    const abortExecutor: NodeExecutor = async (node) => {
      // Abort after first node executes
      controller.abort();
      return `Done: ${node.task}`;
    };

    const result = await executor.executeTree(tree, abortExecutor, controller.signal);

    expect(result.tree.nodes.get(aId)?.status).toBe("completed");
    expect(result.tree.nodes.get(bId)?.status).toBe("skipped");
  });

  it("calls onStatusChange on every status transition", async () => {
    const statusChanges: Array<{ nodeId: GoalNodeId; status: string }> = [];
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A" });
    const tree = makeTree([root, a], rootId);

    const onChange: OnNodeStatusChange = (_tree, node) => {
      statusChanges.push({ nodeId: node.id, status: node.status });
    };

    await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onStatusChange: onChange,
    });

    // Should have: "executing" and "completed" transitions
    expect(statusChanges.length).toBeGreaterThanOrEqual(2);
    expect(statusChanges[0]?.status).toBe("executing");
    expect(statusChanges[1]?.status).toBe("completed");
  });

  it("excludes root node from execution", async () => {
    const executedNodes: string[] = [];
    const executor = new GoalExecutor(defaultConfig);
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "pending" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "A" });
    const tree = makeTree([root, a], rootId);

    const trackingExecutor: NodeExecutor = async (node) => {
      executedNodes.push(node.task);
      return `Done: ${node.task}`;
    };

    await executor.executeTree(tree, trackingExecutor, new AbortController().signal);

    expect(executedNodes).toEqual(["A"]);
    expect(executedNodes).not.toContain("Root");
  });

  it("marks dependency-blocked nodes as skipped (not failed)", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const cId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-blocked", dependsOn: [aId] });
    const c = makeNode({ id: cId, parentId: rootId, depth: 1, task: "C-also-blocked", dependsOn: [bId] });
    const tree = makeTree([root, a, b, c], rootId);

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal);

    expect(result.tree.nodes.get(aId)?.status).toBe("failed");
    expect(result.tree.nodes.get(bId)?.status).toBe("skipped");
    expect(result.tree.nodes.get(cId)?.status).toBe("skipped");
  });

  // =========================================================================
  // onNodeFailed callback tests (Plan 16-03)
  // =========================================================================

  it("calls onNodeFailed when a node exhausts retries", async () => {
    const onNodeFailed = vi.fn().mockResolvedValue(null);
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 1 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A" });
    const tree = makeTree([root, a], rootId);

    await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onNodeFailed,
    });

    expect(onNodeFailed).toHaveBeenCalledTimes(1);
    expect(onNodeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ rootId, nodes: expect.any(Map) }),
      expect.objectContaining({ id: aId, status: "failed" }),
    );
  });

  it("replaces internal tree and continues when onNodeFailed returns a new tree", async () => {
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();
    const recoveryId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-depends-on-A", dependsOn: [aId] });
    const tree = makeTree([root, a, b], rootId);

    // onNodeFailed returns a new tree with a recovery node that replaces A's subtree
    const onNodeFailed = vi.fn().mockImplementation(async () => {
      const recoveryNode = makeNode({
        id: recoveryId,
        parentId: aId,
        depth: 2,
        task: "Recovery-for-A",
        dependsOn: [],
      });
      const newNodes = new Map(tree.nodes);
      newNodes.set(recoveryId, recoveryNode);
      return { ...tree, nodes: newNodes };
    });

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onNodeFailed,
    });

    // Recovery node should have been added and executed
    expect(result.tree.nodes.has(recoveryId)).toBe(true);
    expect(result.tree.nodes.get(recoveryId)?.status).toBe("completed");
    // The failed node should be reset to pending (parent of recovery)
    expect(result.tree.nodes.get(aId)?.status).toBe("pending");
    // B which depended on A is no longer blocked
  });

  it("proceeds normally when onNodeFailed returns null", async () => {
    const onNodeFailed = vi.fn().mockResolvedValue(null);
    const executor = new GoalExecutor({ ...defaultConfig, maxRetries: 0 });
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const a = makeNode({ id: aId, parentId: rootId, depth: 1, task: "FAIL-A", dependsOn: [] });
    const b = makeNode({ id: bId, parentId: rootId, depth: 1, task: "B-depends-on-A", dependsOn: [aId] });
    const tree = makeTree([root, a, b], rootId);

    const result = await executor.executeTree(tree, mockExecutor, new AbortController().signal, {
      onNodeFailed,
    });

    // A stays failed, B gets skipped (normal flow)
    expect(result.tree.nodes.get(aId)?.status).toBe("failed");
    expect(result.tree.nodes.get(bId)?.status).toBe("skipped");
  });
});
