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
    // The budget stops LAUNCHES after 3 failures; the nodes already in flight
    // (at most the wave width, 4) still settle. Overshoot is bounded by width.
    const failed = results.filter(r => r.status === "failed");
    expect(failed.length).toBeLessThanOrEqual(4);
    expect(executeNode.mock.calls.length).toBeLessThanOrEqual(4);
    expect(results.filter(r => r.status === "skipped").length).toBeGreaterThanOrEqual(1);
    expect(results).toHaveLength(5);
  });

  // audited 2026-09-02: the failure budget reserved a permit per IN-FLIGHT node and
  // made the dispatch loop wait for one to free up, so a wave could never run wider
  // than maxFailureBudget (3 by default) no matter what maxParallelNodes said. The
  // budget is documented as "stop after N failures", not a second semaphore.
  it("wave width is bounded by maxParallelNodes, not by the failure budget", async () => {
    let inFlight = 0;
    let peak = 0;
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return makeOkResult(node.id, node.assignedProvider!);
    });

    const nodes = Array.from({ length: 12 }, (_, i) =>
      makeAssignedNode(`N${i}`, `Task ${i}`, "claude"));

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 12, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);

    expect(results).toHaveLength(12);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(peak).toBe(12);
  });

  it("stops launching nodes once the failure budget is spent", async () => {
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => ({
      ...makeOkResult(node.id), status: "failed" as const, output: "boom",
    }));

    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeAssignedNode(`N${i}`, `Task ${i}`, "claude"));

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);

    expect(executeNode).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.status === "failed")).toHaveLength(3);
    const skipped = results.filter((r) => r.status === "skipped");
    expect(skipped).toHaveLength(2);
    expect(skipped.every((r) => r.output === "Skipped: budget exhausted")).toBe(true);
  });

  // audited 2026-09-02: once the failure budget was spent the wave loop hit
  // `break`, so every node in a later wave produced no NodeResult and no event
  // at all. The aggregator's totalNodes = results.length shrank to match, and a
  // 10-node plan settled as "3 nodes, all failed" — the seven planned-but-never-
  // attempted sub-goals vanished from the census. Same class findUnschedulableNodes
  // closed for cycles; the fix: drain the remaining waves as skipped results.
  it("accounts for every node in later waves after the failure budget is spent", async () => {
    const executed: string[] = [];
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      executed.push(String(node.id));
      return String(node.id).startsWith("F")
        ? { ...makeOkResult(String(node.id)), status: "failed" as const, output: "boom" }
        : makeOkResult(String(node.id));
    });
    const emitter = { emit: vi.fn() };
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      eventEmitter: emitter as any,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 2 },
    });
    // wave 0: S(ok), F1(fail), F2(fail) -> budget spent
    // wave 1: X depends only on the SUCCEEDED S — genuinely runnable
    // wave 2: Y depends on X
    const nodes = [
      makeAssignedNode("S", "setup", "claude"),
      makeAssignedNode("F1", "fails", "claude"),
      makeAssignedNode("F2", "fails", "claude"),
      makeAssignedNode("X", "after setup", "claude", ["S"]),
      makeAssignedNode("Y", "after X", "claude", ["X"]),
    ];

    const results = await dispatcher.dispatch(nodes);

    expect(executed).toEqual(["S", "F1", "F2"]);
    expect(results.map((r) => String(r.nodeId)).sort()).toEqual(["F1", "F2", "S", "X", "Y"]);
    const byId = new Map(results.map((r) => [String(r.nodeId), r]));
    expect(byId.get("X")).toMatchObject({ status: "skipped", output: "Skipped: budget exhausted" });
    expect(byId.get("Y")).toMatchObject({ status: "skipped", output: "Skipped: budget exhausted" });
    // Each unattempted node still reaches the monitor as a terminal event.
    const completed = emitter.emit.mock.calls
      .filter((c) => c[0] === "supervisor:node_complete")
      .map((c) => String((c[1] as { nodeId: string }).nodeId));
    expect(completed).toEqual(expect.arrayContaining(["X", "Y"]));
    // No wave_start for a wave that never launched.
    const waveStarts = emitter.emit.mock.calls.filter((c) => c[0] === "supervisor:wave_start");
    expect(waveStarts).toHaveLength(1);
  });

  it("does not skip nodes just because the failure budget is lower than node count", async () => {
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) =>
      makeOkResult(node.id, node.assignedProvider!)
    );

    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeAssignedNode(`N${i}`, `Task ${i}`, "claude"));

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });
    const results = await dispatcher.dispatch(nodes);

    expect(executeNode).toHaveBeenCalledTimes(5);
    expect(results).toHaveLength(5);
    expect(results.every((result) => result.status === "ok")).toBe(true);
  });

  // Regression (H12): A fails -> B (deps A) skips -> C (deps B) must ALSO skip.
  // Without tracking skipped node ids, C would not see B in failedNodeIds (B was
  // skipped, not failed) and would execute with an unsatisfied dependency.
  it("transitively skips dependents of a skipped node", async () => {
    const executed: string[] = [];
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      executed.push(String(node.id));
      return String(node.id) === "A"
        ? { ...makeOkResult(String(node.id)), status: "failed" as const, output: "boom" }
        : makeOkResult(String(node.id));
    });
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 2, nodeTimeoutMs: 5000, maxFailureBudget: 10 },
    });
    const nodes = [
      makeAssignedNode("A", "a", "claude"),
      makeAssignedNode("B", "b", "claude", ["A"]),
      makeAssignedNode("C", "c", "claude", ["B"]),
    ];

    const results = await dispatcher.dispatch(nodes);

    expect(executed).toEqual(["A"]); // B + C never executed
    const status = new Map(results.map((r) => [String(r.nodeId), r.status]));
    expect(status.get("B")).toBe("skipped");
    expect(status.get("C")).toBe("skipped");
  });

  it("emits failure reasons in monitor task updates", async () => {
    const emit = vi.fn();
    const executeNode = vi.fn().mockResolvedValue({
      ...makeOkResult("A"),
      status: "failed" as const,
      output: "Aborted",
    });

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
      eventEmitter: { emit },
      rootId: "root-1",
    });

    await dispatcher.dispatch([makeAssignedNode("A", "Task A", "claude")]);

    expect(emit).toHaveBeenCalledWith("monitor:task_update", expect.objectContaining({
      rootId: "root-1",
      nodeId: "A",
      status: "failed",
      error: "Aborted",
    }));
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

  // audited 2026-09-02: the per-node timeout surfaced as "... reason=timeout-or-
  // node-abort", isTransientError substring-matched "timeout", and attempt 0 slept
  // 2s and ran the whole node AGAIN — a stuck node burned two full windows (up to
  // 6h + 6h with the shipped defaults) before it was reported failed, with the
  // abandoned first run still executing in the background.
  it("does not retry a node that hit its own per-node timeout", async () => {
    const executeNode = vi.fn().mockImplementation(
      () => new Promise<NodeResult>((resolve) => setTimeout(() => resolve(makeOkResult("X")), 5000)),
    );
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 100, maxFailureBudget: 3 },
    });

    const startedAt = Date.now();
    const results = await dispatcher.dispatch([makeAssignedNode("X", "Stuck task", "claude")]);
    const elapsed = Date.now() - startedAt;

    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.output).toContain("per-node-timeout");
    expect(results[0]?.output).toContain("Tool timeout after 100ms");
    expect(elapsed).toBeLessThan(1500); // no 2s transient backoff, no second window
  });

  it("does not retry a non-transient node error", async () => {
    // The catch used to abort the node controller BEFORE classifying the error,
    // so every error read as "timeout-or-node-abort" and was retried as transient.
    const executeNode = vi.fn().mockRejectedValue(new Error("Compilation failed: syntax error in Player.cs"));
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 5000, maxFailureBudget: 3 },
    });

    const results = await dispatcher.dispatch([makeAssignedNode("X", "Compile", "claude")]);

    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.output).toContain("Compilation failed");
    expect(results[0]?.output).toContain("reason=node-error");
  });

  it("passes an abortable node signal to the executor on timeout", async () => {
    let observedAbort = false;
    const executeNode = vi.fn().mockImplementation(
      async (_node: TaggedGoalNode, signal: AbortSignal) =>
        new Promise<NodeResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new Error("Aborted"));
          }, { once: true });
        })
    );

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 50, maxFailureBudget: 3 },
    });

    const results = await dispatcher.dispatch([makeAssignedNode("X", "Slow task", "claude")]);

    expect(results[0]?.status).toBe("failed");
    expect(observedAbort).toBe(true);
    expect(executeNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "X" }),
      expect.any(AbortSignal),
    );
  });

  // audit #13 (PRODUCING-HALF): a control-plane abort of an IN-FLIGHT node is a
  // benign cancel, not a failure. It must yield a first-class "cancelled" status
  // (excluded from the failure gate) instead of "failed" — otherwise a user/sibling
  // cancel floods logs with "All providers failed" error-noise.
  it("marks an in-flight node cancelled (not failed) on control-plane abort", async () => {
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

    // Abort after 50ms (external/control-plane cancel while the node is running)
    setTimeout(() => controller.abort(), 50);
    const results = await dispatcher.dispatch(nodes, controller.signal);
    expect(results[0].status).toBe("cancelled");
  });

  // audit #13: a node that has NOT yet launched when the control-plane signal aborts
  // mid-wave must also be "cancelled", not "skipped" (skipped is reserved for budget
  // exhaustion / failed-dependency). Covers the first pre-launch guard.
  it("marks not-yet-launched nodes cancelled when the control-plane signal aborts mid-wave", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      started.push(String(node.id));
      if (String(node.id) === "A") {
        controller.abort(); // abort synchronously while the wave is being iterated
        return makeOkResult("A");
      }
      return makeOkResult(String(node.id));
    });

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 60000, maxFailureBudget: 5 },
    });
    const nodes = [
      makeAssignedNode("A", "a", "claude"),
      makeAssignedNode("B", "b", "claude"),
      makeAssignedNode("C", "c", "claude"),
    ];

    const results = await dispatcher.dispatch(nodes, controller.signal);
    const status = new Map(results.map((r) => [String(r.nodeId), r.status]));
    expect(status.get("B")).toBe("cancelled");
    expect(status.get("C")).toBe("cancelled");
    expect(started).not.toContain("B"); // never launched
    expect(started).not.toContain("C");
  });

  // audit #13: a node waiting on a concurrency slot when the abort lands (the second
  // pre-launch guard, after concurrency.acquire) is likewise cancelled, not skipped.
  it("marks a node waiting for a concurrency slot cancelled when aborted mid-wait", async () => {
    const controller = new AbortController();
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    const started: string[] = [];
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      started.push(String(node.id));
      if (String(node.id) === "A") {
        await aGate; // hold the only slot until the test releases it
        return makeOkResult("A");
      }
      return makeOkResult(String(node.id));
    });

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 1, nodeTimeoutMs: 60000, maxFailureBudget: 5 },
    });
    const nodes = [
      makeAssignedNode("A", "a", "claude"),
      makeAssignedNode("B", "b", "claude"),
    ];

    const resultsPromise = dispatcher.dispatch(nodes, controller.signal);
    // Let A take the only slot and B queue on concurrency.acquire(), then abort and
    // release A so B resumes from the queue straight into the post-acquire guard.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    releaseA();

    const results = await resultsPromise;
    const status = new Map(results.map((r) => [String(r.nodeId), r.status]));
    expect(status.get("B")).toBe("cancelled");
    expect(started).not.toContain("B"); // never launched
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
