import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLogger } from "../utils/logger.js";
import { SupervisorDispatcher } from "./supervisor-dispatcher.js";
import type { TaggedGoalNode, NodeResult } from "./supervisor-types.js";

function node(id: string, dependsOn: string[] = []): TaggedGoalNode {
  return {
    id,
    parentId: null,
    task: `task ${id}`,
    dependsOn,
    depth: 1,
    status: "pending",
    createdAt: 0,
    updatedAt: 0,
    capabilityProfile: {},
    assignedProvider: "mock",
  } as unknown as TaggedGoalNode;
}

function mkDispatcher(
  executeNode?: (n: TaggedGoalNode) => Promise<NodeResult>,
): SupervisorDispatcher {
  return new SupervisorDispatcher({
    executeNode: executeNode
      ? (n) => executeNode(n)
      : async (n) => ({
        nodeId: n.id,
        status: "ok" as const,
        output: "done",
        artifacts: [],
        toolResults: [],
        provider: "mock",
        model: "mock-model",
        cost: 0,
        duration: 1,
      }),
    config: { maxParallelNodes: 2, nodeTimeoutMs: 5_000, maxFailureBudget: 5 },
  });
}

describe("SupervisorDispatcher — dependency cycles are not silent", () => {
  beforeAll(() => {
    createLogger("error", "test.log");
  });

  it("computeWaves drops cyclic nodes (documented behaviour)", () => {
    const d = mkDispatcher();
    // a → b → a is a cycle; c is independent and schedulable.
    const nodes = [node("a", ["b"]), node("b", ["a"]), node("c")];
    const waves = d.computeWaves(nodes);
    const scheduled = waves.flat().map((n) => String(n.id));
    expect(scheduled).toEqual(["c"]);
  });

  it("findUnschedulableNodes reports exactly the nodes left out", () => {
    const d = mkDispatcher();
    const nodes = [node("a", ["b"]), node("b", ["a"]), node("c")];
    const waves = d.computeWaves(nodes);
    const stuck = d.findUnschedulableNodes(nodes, waves).map((n) => String(n.id));
    expect(stuck.sort()).toEqual(["a", "b"]);
  });

  it("returns a FAILED result for every unschedulable node", async () => {
    // Regression: cyclic nodes were dropped by computeWaves and never appeared
    // in dispatch's results, so a caller aggregating results saw zero failures
    // and reported the truncated DAG as fully complete — telling the user work
    // was finished that had never been scheduled.
    const d = mkDispatcher();
    const nodes = [node("a", ["b"]), node("b", ["a"]), node("c")];

    const results = await d.dispatch(nodes);

    // Every input node is accounted for.
    expect(results.map((r) => String(r.nodeId)).sort()).toEqual(["a", "b", "c"]);

    const byId = new Map(results.map((r) => [String(r.nodeId), r]));
    expect(byId.get("c")!.status).toBe("ok");
    expect(byId.get("a")!.status).toBe("failed");
    expect(byId.get("b")!.status).toBe("failed");
    expect(byId.get("a")!.blockedReason).toMatch(/dependency cycle/i);
  });

  it("a fully cyclic goal yields no successes at all", async () => {
    const d = mkDispatcher();
    const nodes = [node("x", ["y"]), node("y", ["x"])];
    const results = await d.dispatch(nodes);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "failed")).toBe(true);
  });

  it("an acyclic goal is unaffected", async () => {
    const executed: string[] = [];
    const d = mkDispatcher(async (n) => {
      executed.push(String(n.id));
      return {
        nodeId: n.id, status: "ok", output: "", artifacts: [], toolResults: [],
        provider: "mock", model: "m", cost: 0, duration: 1,
      };
    });
    const nodes = [node("a"), node("b", ["a"]), node("c", ["b"])];

    const results = await d.dispatch(nodes);

    expect(executed).toEqual(["a", "b", "c"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results).toHaveLength(3);
  });

  it("does not fabricate results when nothing is cyclic", async () => {
    const d = mkDispatcher();
    const nodes = [node("solo")];
    const results = await d.dispatch(nodes);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
  });
});
