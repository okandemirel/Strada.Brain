import { describe, it, expect, vi } from "vitest";
import { SupervisorBrain } from "../supervisor-brain.js";
import type { GoalTree, GoalNode } from "../../goals/types.js";
import type { SupervisorConfig, NodeResult } from "../supervisor-types.js";
import { CapabilityMatcher } from "../capability-matcher.js";
import { ProviderAssigner } from "../provider-assigner.js";

function makeGoalTree(nodes: Array<{ id: string; task: string; deps?: string[] }>): GoalTree {
  const nodeMap = new Map() as any;
  for (const n of nodes) {
    nodeMap.set(n.id, {
      id: n.id, parentId: nodes[0].id === n.id ? null : nodes[0].id,
      task: n.task, dependsOn: (n.deps ?? []),
      depth: nodes[0].id === n.id ? 0 : 1,
      status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  return { rootId: nodes[0].id as any, sessionId: "s1", taskDescription: "Test", nodes: nodeMap, createdAt: Date.now() };
}

const PROVIDERS = [
  { name: "claude", model: "sonnet", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } },
];

const DEFAULT_CONFIG: SupervisorConfig = {
  enabled: true, complexityThreshold: "complex", maxParallelNodes: 4,
  nodeTimeoutMs: 5000, verificationMode: "disabled", verificationBudgetPct: 15,
  triageProvider: "groq", maxFailureBudget: 3, diversityCap: 0.6,
};

describe("SupervisorBrain", () => {
  it("runs full pipeline: decompose → match → assign → dispatch → aggregate", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([
          { id: "root", task: "Build auth" },
          { id: "s1", task: "Create DB schema" },
          { id: "s2", task: "Implement endpoint", deps: ["s1"] },
        ]),
      ),
    };

    const executeNode = vi.fn().mockImplementation(async (node: any) => ({
      nodeId: node.id, status: "ok", output: `Done: ${node.task}`,
      artifacts: [], toolResults: [], provider: "claude", model: "sonnet", cost: 0.001, duration: 100,
    }));

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });
    brain.setExecuteNode(executeNode);

    const result = await brain.execute("Build auth system", { chatId: "test" });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.succeeded).toBe(2); // s1 + s2 (root excluded)
    expect(decomposer.decomposeProactive).toHaveBeenCalledTimes(1);
    expect(executeNode).toHaveBeenCalledTimes(2);
  });

  it("returns null for non-decomposable tasks", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(false),
      decomposeProactive: vi.fn(),
    };

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });

    const result = await brain.execute("hi", { chatId: "test" });
    expect(result).toBeNull();
    expect(decomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("uses a provided goalTree even when prompt decomposition is disabled", async () => {
    const goalTree = makeGoalTree([
      { id: "root", task: "Inspect design" },
      { id: "s1", task: "Compare layout" },
    ]);
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(false),
      decomposeProactive: vi.fn(),
    };
    const executeNode = vi.fn().mockResolvedValue({
      nodeId: "s1",
      status: "ok",
      output: "Compared layout",
      artifacts: [],
      toolResults: [],
      provider: "claude",
      model: "sonnet",
      cost: 0,
      duration: 10,
    } satisfies NodeResult);

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });
    brain.setExecuteNode(executeNode);

    const result = await brain.execute("simple prompt", {
      chatId: "test",
      goalTree,
    });

    expect(result?.success).toBe(true);
    expect(decomposer.decomposeProactive).not.toHaveBeenCalled();
    expect(executeNode).toHaveBeenCalledTimes(1);
  });

  it("throws if executeNode not set", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([{ id: "root", task: "Task" }, { id: "s1", task: "Sub" }]),
      ),
    };

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });
    // Note: setExecuteNode NOT called
    await expect(brain.execute("Do something", { chatId: "test" })).rejects.toThrow();
  });

  it("handles abort signal gracefully", async () => {
    const controller = new AbortController();
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockImplementation(async () => {
        controller.abort();
        return makeGoalTree([{ id: "root", task: "Task" }, { id: "s1", task: "Sub" }]);
      }),
    };

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });
    brain.setExecuteNode(vi.fn().mockResolvedValue({
      nodeId: "s1", status: "ok", output: "done", artifacts: [], toolResults: [],
      provider: "claude", model: "sonnet", cost: 0, duration: 0,
    }));

    const result = await brain.execute("Build", { chatId: "test", signal: controller.signal });
    // Should handle abort gracefully - either partial result or error caught
    expect(result).toBeDefined();
  });

  it("propagates brain aborts even when an external signal is present", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([{ id: "root", task: "Task" }, { id: "s1", task: "Sub" }]),
      ),
    };
    let abortObserved = false;

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });
    brain.setExecuteNode(vi.fn().mockImplementation(async (_node: GoalNode, context) => {
      await new Promise<never>((_resolve, reject) => {
        const signal = context.signal;
        if (!signal) {
          reject(new Error("Missing signal"));
          return;
        }
        if (signal.aborted) {
          abortObserved = true;
          reject(new Error("Aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("Aborted"));
        }, { once: true });
      });
      return {
        nodeId: "s1",
        status: "ok",
        output: "done",
        artifacts: [],
        toolResults: [],
        provider: "claude",
        model: "sonnet",
        cost: 0,
        duration: 0,
      } satisfies NodeResult;
    }));

    const externalController = new AbortController();
    const runPromise = brain.execute("Build", { chatId: "test", signal: externalController.signal });
    await vi.waitFor(() => {
      expect(decomposer.decomposeProactive).toHaveBeenCalledTimes(1);
    });

    brain.abort();

    const result = await Promise.race([
      runPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(result).not.toBeNull();
    expect(abortObserved).toBe(true);
  });

  it("emits telemetry events", async () => {
    const emitter = { emit: vi.fn() };
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([{ id: "root", task: "Build" }, { id: "s1", task: "Sub task" }]),
      ),
    };

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
      eventEmitter: emitter,
    });
    brain.setExecuteNode(vi.fn().mockResolvedValue({
      nodeId: "s1", status: "ok", output: "done", artifacts: [], toolResults: [],
      provider: "claude", model: "sonnet", cost: 0.001, duration: 100,
    }));

    await brain.execute("Build something complex", { chatId: "test" });
    const events = emitter.emit.mock.calls.map(c => c[0]);
    expect(events).toContain("supervisor:activated");
    expect(events).toContain("supervisor:plan_ready");
    expect(events).toContain("supervisor:complete");
  });
});
