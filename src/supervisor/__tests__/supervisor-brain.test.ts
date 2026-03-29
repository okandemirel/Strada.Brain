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

  it("runs supervisor verification and feeds the outcome back into provider learning", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([
          { id: "root", task: "Build auth" },
          { id: "s1", task: "Implement endpoint" },
        ]),
      ),
    };
    const executeNode = vi.fn().mockResolvedValue({
      nodeId: "s1",
      status: "ok",
      output: "Endpoint implemented without tests",
      artifacts: [{ path: "src/api/auth.ts", action: "modify" }],
      toolResults: [],
      provider: "claude",
      model: "sonnet",
      cost: 0.001,
      duration: 100,
    } satisfies NodeResult);
    const providerAssigner = new ProviderAssigner(PROVIDERS);
    const recordOutcomeSpy = vi.spyOn(providerAssigner, "recordOutcome");
    const verifyNode = vi.fn().mockResolvedValue({
      verdict: "reject",
      issues: ["Missing test coverage"],
      verifierProvider: "deepseek",
    });

    const brain = new SupervisorBrain({
      config: { ...DEFAULT_CONFIG, verificationMode: "always" },
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner,
      verifyNode,
    });
    brain.setExecuteNode(executeNode);

    const result = await brain.execute("Build auth system", { chatId: "test" });

    expect(verifyNode).toHaveBeenCalledTimes(1);
    expect(result?.success).toBe(false);
    expect(result?.partial).toBe(false);
    expect(result?.nodeResults[0]).toMatchObject({
      nodeId: "s1",
      status: "failed",
      output: "Verification rejected: Missing test coverage",
    });
    expect(recordOutcomeSpy).toHaveBeenCalledWith("claude", expect.any(Array), false);
  });

  it("limits critical-only verification to quality-sensitive nodes", async () => {
    const goalTree = makeGoalTree([
      { id: "root", task: "Review release" },
      { id: "s1", task: "Critical security review" },
      { id: "s2", task: "Quick lint" },
    ]);
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(false),
      decomposeProactive: vi.fn(),
    };
    const executeNode = vi.fn()
      .mockResolvedValueOnce({
        nodeId: "s1",
        status: "ok",
        output: "Security review done",
        artifacts: [],
        toolResults: [],
        provider: "claude",
        model: "sonnet",
        cost: 0.001,
        duration: 50,
      } satisfies NodeResult)
      .mockResolvedValueOnce({
        nodeId: "s2",
        status: "ok",
        output: "Lint done",
        artifacts: [],
        toolResults: [],
        provider: "claude",
        model: "sonnet",
        cost: 0.001,
        duration: 50,
      } satisfies NodeResult);
    const verifyNode = vi.fn().mockResolvedValue({
      verdict: "approve",
      verifierProvider: "deepseek",
    });

    const brain = new SupervisorBrain({
      config: { ...DEFAULT_CONFIG, verificationMode: "critical-only" },
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
      verifyNode,
    });
    brain.setExecuteNode(executeNode);

    const result = await brain.execute("Review release readiness", {
      chatId: "test",
      goalTree,
    });

    expect(result?.success).toBe(true);
    expect(verifyNode).toHaveBeenCalledTimes(1);
    expect(verifyNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "s1" }),
      expect.anything(),
    );
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

  it("uses planningPrompt for decomposition while keeping the visible task stable", async () => {
    const planningTask = "Inspect this screenshot\n\nAvailable inputs:\n- Image attachment: layout.png (image/png)";
    const now = Date.now();
    const decomposer = {
      shouldDecompose: vi.fn().mockImplementation((prompt: string) => prompt.includes("Image attachment")),
      decomposeProactive: vi.fn().mockResolvedValue({
        rootId: "root" as any,
        sessionId: "s1",
        taskDescription: planningTask,
        planSummary: "Fallback single-step execution",
        createdAt: now,
        nodes: new Map([
          ["root", {
            id: "root",
            parentId: null,
            task: planningTask,
            dependsOn: [],
            depth: 0,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          }],
          ["s1", {
            id: "s1",
            parentId: "root",
            task: planningTask,
            dependsOn: [],
            depth: 1,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          }],
        ]),
      }),
    };
    const executeNode = vi.fn().mockResolvedValue({
      nodeId: "s1",
      status: "ok",
      output: "Image analyzed",
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

    const onGoalDecomposed = vi.fn();
    const result = await brain.execute("Inspect this screenshot", {
      chatId: "test",
      planningPrompt: planningTask,
      onGoalDecomposed,
    });

    expect(result?.success).toBe(true);
    expect(decomposer.shouldDecompose).toHaveBeenCalledWith(
      planningTask,
    );
    expect(decomposer.decomposeProactive).toHaveBeenCalledWith(
      "test",
      planningTask,
    );
    const visibleGoalTree = onGoalDecomposed.mock.calls[0]?.[0];
    expect(visibleGoalTree).toMatchObject({
      taskDescription: "Inspect this screenshot",
    });
    expect(visibleGoalTree?.nodes.get("root")?.task).toBe("Inspect this screenshot");
    expect(visibleGoalTree?.nodes.get("s1")?.task).toBe("Inspect this screenshot");
    expect(executeNode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1",
        task: planningTask,
      }),
      expect.anything(),
      expect.anything(), // AbortSignal from dispatcher
    );
    expect(executeNode).toHaveBeenCalledTimes(1);
  });

  it("serializes supervisor node execution when a shared workspace lease is present", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([
          { id: "root", task: "Build auth" },
          { id: "s1", task: "Edit model" },
          { id: "s2", task: "Edit controller" },
        ]),
      ),
    };

    let releaseFirstNode: (() => void) | undefined;
    const firstNodeStarted = new Promise<void>((resolve) => {
      releaseFirstNode = resolve;
    });
    let firstInvocation = true;
    const executeNode = vi.fn().mockImplementation(async (node: any) => {
      if (firstInvocation) {
        firstInvocation = false;
        await firstNodeStarted;
      }
      return {
        nodeId: node.id,
        status: "ok",
        output: `Done: ${node.task}`,
        artifacts: [],
        toolResults: [],
        provider: "claude",
        model: "sonnet",
        cost: 0.001,
        duration: 100,
      } satisfies NodeResult;
    });

    const brain = new SupervisorBrain({
      config: DEFAULT_CONFIG,
      decomposer: decomposer as any,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner(PROVIDERS),
    });
    brain.setExecuteNode(executeNode);

    const execution = brain.execute("Build auth system", {
      chatId: "test",
      workspaceLease: {
        id: "lease-1",
        kind: "temp-copy",
        sourceRoot: "/tmp/source",
        leaseRoot: "/tmp",
        path: "/tmp/workspace",
        createdAt: Date.now(),
        release: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(executeNode).toHaveBeenCalledTimes(1);
    });

    releaseFirstNode?.();

    const result = await execution;
    expect(result?.success).toBe(true);
    expect(executeNode).toHaveBeenCalledTimes(2);
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
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
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
