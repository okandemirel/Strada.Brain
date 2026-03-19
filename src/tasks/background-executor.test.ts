import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";
import type { Task } from "./types.js";
import { TaskStatus } from "./types.js";
import type { GoalTree, GoalNode, GoalNodeId } from "../goals/types.js";
import { generateGoalNodeId } from "../goals/types.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockOrchestrator() {
  return {
    runBackgroundTask: vi.fn().mockResolvedValue("task done"),
    synthesizeGoalExecutionResult: vi.fn().mockResolvedValue("task done"),
  };
}

function createMockDecomposer() {
  return {
    shouldDecompose: vi.fn().mockReturnValue(false),
    decomposeProactive: vi.fn(),
  };
}

function createMockGoalStorage() {
  return {
    upsertTree: vi.fn(),
    updateNodeStatus: vi.fn(),
  };
}

function createMockDaemonEventBus() {
  return {
    emit: vi.fn(),
  };
}

function buildTestGoalTree(): GoalTree {
  const rootId = generateGoalNodeId();
  const child1Id = generateGoalNodeId();
  const child2Id = generateGoalNodeId();
  const now = Date.now();
  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, {
    id: rootId, parentId: null, task: "Root task",
    dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now,
  });
  nodes.set(child1Id, {
    id: child1Id, parentId: rootId, task: "Step 1",
    dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
  });
  nodes.set(child2Id, {
    id: child2Id, parentId: rootId, task: "Step 2",
    dependsOn: [child1Id], depth: 1, status: "pending", createdAt: now, updatedAt: now,
  });
  return {
    rootId, sessionId: "test-session", taskDescription: "Root task",
    planSummary: "Test plan", nodes, createdAt: now,
  };
}

function createTestTask(goalTree?: GoalTree, overrides: Partial<Task> = {}): Task {
  return {
    id: "task_test123" as any,
    chatId: "chat1",
    channelType: "cli",
    title: "Test task",
    status: TaskStatus.pending,
    prompt: "Do something complex",
    progress: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    goalTree,
    ...overrides,
  };
}

describe("BackgroundExecutor - Pre-decomposed Tree Path", () => {
  let mockOrch: ReturnType<typeof createMockOrchestrator>;
  let mockDecomposer: ReturnType<typeof createMockDecomposer>;
  let mockGoalStorage: ReturnType<typeof createMockGoalStorage>;
  let mockDaemonEventBus: ReturnType<typeof createMockDaemonEventBus>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    mockDecomposer = createMockDecomposer();
    mockGoalStorage = createMockGoalStorage();
    mockDaemonEventBus = createMockDaemonEventBus();
  });

  it("uses pre-decomposed goalTree when set on task (skips decomposer.decomposeProactive)", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    // Wait for execution to complete
    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();

    // Decomposer.decomposeProactive should NOT have been called
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("falls back to decomposer when task has no goalTree and shouldDecompose returns true", async () => {
    const task = createTestTask(); // no goalTree
    const goalTree = buildTestGoalTree();

    mockDecomposer.shouldDecompose.mockReturnValue(true);
    mockDecomposer.decomposeProactive.mockResolvedValue(goalTree);

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();

    // Decomposer.decomposeProactive SHOULD have been called
    expect(mockDecomposer.decomposeProactive).toHaveBeenCalled();
  });

  it("does not overwrite cancelled tasks back to executing when already aborted", async () => {
    const task = createTestTask();
    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    ac.abort();
    executor.enqueue(task, ac.signal, onProgress);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockTaskManager.updateStatus).not.toHaveBeenCalled();
    expect(mockTaskManager.complete).not.toHaveBeenCalled();
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalledWith("Task started");
  });

  it("never runs two tasks from the same conversation in parallel", async () => {
    let releaseFirstTask: (() => void) | undefined;
    const runBackgroundTask = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseFirstTask = resolve;
        });
        return "first done";
      })
      .mockResolvedValueOnce("second done")
      .mockResolvedValueOnce("third done");

    const executor = new BackgroundExecutor({
      orchestrator: { runBackgroundTask } as any,
      concurrencyLimit: 2,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(
      createTestTask(undefined, { id: "task_same_1" as any, chatId: "shared", channelType: "web" }),
      new AbortController().signal,
      vi.fn(),
    );
    executor.enqueue(
      createTestTask(undefined, { id: "task_same_2" as any, chatId: "shared", channelType: "web" }),
      new AbortController().signal,
      vi.fn(),
    );
    executor.enqueue(
      createTestTask(undefined, { id: "task_other" as any, chatId: "other", channelType: "web" }),
      new AbortController().signal,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(runBackgroundTask).toHaveBeenCalledTimes(2);
    }, { timeout: 5000 });

    expect(runBackgroundTask.mock.calls[0]?.[1]?.chatId).toBe("shared");
    expect(runBackgroundTask.mock.calls[0]?.[1]?.taskRunId).toBe("task_same_1");
    expect(runBackgroundTask.mock.calls[1]?.[1]?.chatId).toBe("other");
    expect(runBackgroundTask.mock.calls[1]?.[1]?.taskRunId).toBe("task_other");

    releaseFirstTask?.();

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledTimes(3);
    }, { timeout: 5000 });

    expect(runBackgroundTask.mock.calls[2]?.[1]?.chatId).toBe("shared");
    expect(runBackgroundTask.mock.calls[2]?.[1]?.taskRunId).toBe("task_same_2");
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
  });

  it("treats matching chat IDs from different channels as separate conversations", async () => {
    const runBackgroundTask = vi.fn().mockResolvedValue("done");
    const executor = new BackgroundExecutor({
      orchestrator: { runBackgroundTask } as any,
      concurrencyLimit: 2,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(
      createTestTask(undefined, { id: "task_cli" as any, chatId: "shared", channelType: "cli" }),
      new AbortController().signal,
      vi.fn(),
    );
    executor.enqueue(
      createTestTask(undefined, { id: "task_web" as any, chatId: "shared", channelType: "web" }),
      new AbortController().signal,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledTimes(2);
    }, { timeout: 5000 });

    expect(runBackgroundTask.mock.calls).toHaveLength(2);
    expect(runBackgroundTask.mock.calls[0]?.[1]?.channelType).not.toBe(runBackgroundTask.mock.calls[1]?.[1]?.channelType);
  });

  it("persists goalTree via GoalStorage.upsertTree at start of execution", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();

    // GoalStorage.upsertTree should have been called with the goalTree
    expect(mockGoalStorage.upsertTree).toHaveBeenCalledWith(
      expect.objectContaining({ rootId: goalTree.rootId }),
      "executing",
    );
  });

  it("emits goal:started event to DaemonEventBus at beginning of execution", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();

    // Should have emitted goal:started event
    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:started",
      expect.objectContaining({
        rootId: goalTree.rootId,
        taskDescription: "Root task",
        timestamp: expect.any(Number),
      }),
    );
  });

  it("emits goal:complete event at end of execution", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();

    // Should have emitted goal:complete event
    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:complete",
      expect.objectContaining({
        rootId: goalTree.rootId,
        taskDescription: "Root task",
        timestamp: expect.any(Number),
      }),
    );
  });

  it("synthesizes a final user-facing result after decomposed execution", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree, {
      prompt: "Reply with only: final synthesized ok",
    });

    mockOrch.runBackgroundTask
      .mockResolvedValueOnce("Sub-goal worker draft A")
      .mockResolvedValueOnce("Sub-goal worker draft B");
    mockOrch.synthesizeGoalExecutionResult.mockResolvedValue("final synthesized ok");

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "final synthesized ok");
    }, { timeout: 5000 });

    expect(mockOrch.synthesizeGoalExecutionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Reply with only: final synthesized ok",
        chatId: task.chatId,
      }),
    );
  });
});

describe("BackgroundExecutor - daemon budget tracking", () => {
  it("records cost for daemon-origin tasks from background usage callbacks", async () => {
    const mockOrch = createMockOrchestrator();
    mockOrch.runBackgroundTask.mockImplementation(async (_prompt: string, opts?: { onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void }) => {
      opts?.onUsage?.({
        provider: "claude",
        inputTokens: 100_000,
        outputTokens: 50_000,
      });
      return "task done";
    });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const budgetTracker = {
      recordCost: vi.fn(),
    };
    executor.setDaemonBudgetTracker(budgetTracker as any);

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(
      createTestTask(undefined, { origin: "daemon", triggerName: "nightly-review" }),
      new AbortController().signal,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();

    expect(budgetTracker.recordCost).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        model: "claude",
        tokensIn: 100_000,
        tokensOut: 50_000,
        triggerName: "nightly-review",
      }),
    );
  });
});

// =============================================================================
// GOAL:FAILED EVENT EMISSION (INT-02)
// =============================================================================

describe("BackgroundExecutor - goal:failed event emission (INT-02)", () => {
  let mockOrch: ReturnType<typeof createMockOrchestrator>;
  let mockDecomposer: ReturnType<typeof createMockDecomposer>;
  let mockGoalStorage: ReturnType<typeof createMockGoalStorage>;
  let mockDaemonEventBus: ReturnType<typeof createMockDaemonEventBus>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    mockDecomposer = createMockDecomposer();
    mockGoalStorage = createMockGoalStorage();
    mockDaemonEventBus = createMockDaemonEventBus();
  });

  it("emits goal:failed event when goal execution has failures", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    // Make the orchestrator fail for all nodes
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Node failed"));

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
      goalExecutorConfig: { maxRetries: 0, maxFailures: 10, parallelExecution: true, maxParallel: 3 },
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(
        task.id,
        expect.stringContaining("sub-goal(s) failed"),
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Should have emitted goal:failed (not goal:complete)
    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:failed",
      expect.objectContaining({
        rootId: goalTree.rootId,
        error: expect.stringContaining("sub-goal(s) failed"),
        failureCount: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    );

    // goal:complete should NOT have been emitted
    const completeEmitCalls = mockDaemonEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "goal:complete",
    );
    expect(completeEmitCalls).toHaveLength(0);
  });

  it("emits goal:failed event when goal execution is aborted", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    // Make the orchestrator slow so we can abort mid-execution
    mockOrch.runBackgroundTask.mockImplementation(async (_prompt: string, opts?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 60000);
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          });
        }
      });
    });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
      goalExecutorConfig: { maxRetries: 0, maxFailures: 10, parallelExecution: true, maxParallel: 3 },
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    // Give it a moment to start, then abort
    await new Promise(r => setTimeout(r, 50));
    ac.abort();

    await vi.waitFor(() => {
      const failedCalls = mockDaemonEventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "goal:failed",
      );
      expect(failedCalls.length).toBeGreaterThan(0);
      expect(failedCalls[0][1]).toEqual(
        expect.objectContaining({
          rootId: goalTree.rootId,
          error: "Goal aborted",
          timestamp: expect.any(Number),
        }),
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();
  });
});

// =============================================================================
// RE-DECOMPOSITION & ESCALATION TESTS (Plan 16-03)
// =============================================================================

function createMockAIProvider(responseText = "DECOMPOSE") {
  return {
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    stream: vi.fn(),
    countTokens: vi.fn().mockReturnValue(10),
  };
}

function createMockLearningEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn(),
  };
}

function buildFailingGoalTree(): GoalTree {
  const rootId = generateGoalNodeId();
  const child1Id = generateGoalNodeId();
  const now = Date.now();
  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, {
    id: rootId, parentId: null, task: "Root task",
    dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now,
  });
  nodes.set(child1Id, {
    id: child1Id, parentId: rootId, task: "Failing step",
    dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
  });
  return {
    rootId, sessionId: "test-session", taskDescription: "Root task",
    planSummary: "Test plan", nodes, createdAt: now,
  };
}

function createMockInteractiveChannel() {
  return {
    name: "test",
    connect: vi.fn(),
    disconnect: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    onMessage: vi.fn(),
    sendText: vi.fn(),
    sendMarkdown: vi.fn(),
    requestConfirmation: vi.fn().mockResolvedValue("Continue"),
  };
}

describe("BackgroundExecutor - Re-decomposition (Plan 16-03)", () => {
  let mockOrch: ReturnType<typeof createMockOrchestrator>;
  let mockDecomposer: ReturnType<typeof createMockDecomposer>;
  let mockGoalStorage: ReturnType<typeof createMockGoalStorage>;
  let mockDaemonEventBus: ReturnType<typeof createMockDaemonEventBus>;
  let mockAIProvider: ReturnType<typeof createMockAIProvider>;
  let mockLearningBus: ReturnType<typeof createMockLearningEventBus>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    mockDecomposer = createMockDecomposer();
    mockGoalStorage = createMockGoalStorage();
    mockDaemonEventBus = createMockDaemonEventBus();
    mockAIProvider = createMockAIProvider("DECOMPOSE");
    mockLearningBus = createMockLearningEventBus();
  });

  it("LLM decides 'redecompose' -> calls decomposeReactive, emits goal:redecomposed", async () => {
    const goalTree = buildFailingGoalTree();
    const task = createTestTask(goalTree);

    // Make the orchestrator fail so node fails
    let callCount = 0;
    mockOrch.runBackgroundTask.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("Task failed"); // fail initial + retry
      return "recovered";
    });

    // LLM advises DECOMPOSE
    mockAIProvider.chat.mockResolvedValue({ text: "DECOMPOSE" });

    // Decomposer returns a new tree with recovery nodes
    const recoveryNodeId = generateGoalNodeId();
    const failingNodeId = Array.from(goalTree.nodes.keys()).find(id => id !== goalTree.rootId)!;
    mockDecomposer.decomposeReactive = vi.fn().mockImplementation(async () => {
      const newNodes = new Map(goalTree.nodes);
      newNodes.set(recoveryNodeId, {
        id: recoveryNodeId, parentId: failingNodeId, task: "Recovery step",
        dependsOn: [], depth: 2, status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return { ...goalTree, nodes: newNodes };
    });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: undefined,
      goalConfig: { maxFailures: 3, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    executor.enqueue(task, new AbortController().signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    // decomposeReactive should have been called
    expect(mockDecomposer.decomposeReactive).toHaveBeenCalled();

    // Should have emitted goal:redecomposed
    expect(mockLearningBus.emit).toHaveBeenCalledWith(
      "goal:redecomposed",
      expect.objectContaining({
        rootId: goalTree.rootId,
        task: expect.any(String),
        newNodeCount: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    );
  });

  it("LLM decides 'retry' -> emits goal:retry event, returns null", async () => {
    const goalTree = buildFailingGoalTree();
    const task = createTestTask(goalTree);

    // Make all calls fail
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Always fails"));

    // LLM advises RETRY
    mockAIProvider.chat.mockResolvedValue({ text: "RETRY" });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: undefined,
      goalConfig: { maxFailures: 3, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    executor.enqueue(task, new AbortController().signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(
        task.id,
        expect.stringContaining("sub-goal(s) failed"),
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Should have emitted goal:retry
    expect(mockLearningBus.emit).toHaveBeenCalledWith(
      "goal:retry",
      expect.objectContaining({
        rootId: goalTree.rootId,
        task: expect.any(String),
        timestamp: expect.any(Number),
      }),
    );
  });

  it("rejects re-decomposition when redecompositionCount >= maxRedecompositions", async () => {
    const goalTree = buildFailingGoalTree();
    // Set redecompositionCount to maxRedecompositions on failing node
    const failingNodeId = Array.from(goalTree.nodes.keys()).find(id => id !== goalTree.rootId)!;
    const failingNode = goalTree.nodes.get(failingNodeId)!;
    const updatedNodes = new Map(goalTree.nodes);
    updatedNodes.set(failingNodeId, { ...failingNode, redecompositionCount: 2 });
    const treeWithCount: GoalTree = { ...goalTree, nodes: updatedNodes };

    const task = createTestTask(treeWithCount);
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Fails"));
    mockAIProvider.chat.mockResolvedValue({ text: "DECOMPOSE" });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: undefined,
      goalConfig: { maxFailures: 3, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    executor.enqueue(task, new AbortController().signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(
        task.id,
        expect.stringContaining("sub-goal(s) failed"),
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // decomposeReactive should NOT have been called (limit exceeded)
    expect(mockDecomposer.decomposeReactive).not.toBeDefined();
  });

  it("re-decomposition prompt includes completed nodes, failed task, error, original description", async () => {
    const goalTree = buildFailingGoalTree();
    const task = createTestTask(goalTree);

    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Network timeout"));
    mockAIProvider.chat.mockResolvedValue({ text: "DECOMPOSE" });

    // decomposeReactive captures the context
    let capturedContext = "";
    mockDecomposer.decomposeReactive = vi.fn().mockImplementation(
      async (_tree: GoalTree, _failId: string, context: string) => {
        capturedContext = context;
        return null; // Fail gracefully
      },
    );

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: undefined,
      goalConfig: { maxFailures: 3, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    executor.enqueue(task, new AbortController().signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(
        task.id,
        expect.stringContaining("sub-goal(s) failed"),
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Verify context includes key info
    if (mockDecomposer.decomposeReactive.mock.calls.length > 0) {
      expect(capturedContext).toContain("Network timeout");
      expect(capturedContext).toContain("Failing step");
    }
  });
});

describe("BackgroundExecutor - Enhanced Escalation (Plan 16-03)", () => {
  let mockOrch: ReturnType<typeof createMockOrchestrator>;
  let mockDecomposer: ReturnType<typeof createMockDecomposer>;
  let mockGoalStorage: ReturnType<typeof createMockGoalStorage>;
  let mockDaemonEventBus: ReturnType<typeof createMockDaemonEventBus>;
  let mockAIProvider: ReturnType<typeof createMockAIProvider>;
  let mockLearningBus: ReturnType<typeof createMockLearningEventBus>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    mockDecomposer = createMockDecomposer();
    mockGoalStorage = createMockGoalStorage();
    mockDaemonEventBus = createMockDaemonEventBus();
    mockAIProvider = createMockAIProvider();
    mockLearningBus = createMockLearningEventBus();
  });

  it("escalation presents 3 options: Continue, Always Continue, Abort", async () => {
    // Build a tree with multiple failing nodes to exceed budget
    const rootId = generateGoalNodeId();
    const child1Id = generateGoalNodeId();
    const child2Id = generateGoalNodeId();
    const now = Date.now();
    const nodes = new Map<GoalNodeId, GoalNode>();
    nodes.set(rootId, {
      id: rootId, parentId: null, task: "Root",
      dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now,
    });
    nodes.set(child1Id, {
      id: child1Id, parentId: rootId, task: "Fail 1",
      dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
    });
    nodes.set(child2Id, {
      id: child2Id, parentId: rootId, task: "Fail 2",
      dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
    });
    const goalTree: GoalTree = {
      rootId, sessionId: "test", taskDescription: "Multi-fail",
      nodes, createdAt: now,
    };

    const task = createTestTask(goalTree);
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Fails"));

    const mockChannel = createMockInteractiveChannel();
    mockChannel.requestConfirmation.mockResolvedValue("Abort");

    // LLM for recovery advisor returns RETRY so onNodeFailed doesn't redecompose
    mockAIProvider.chat.mockResolvedValue({ text: "RETRY" });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: mockChannel as any,
      goalConfig: { maxFailures: 1, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
      goalExecutorConfig: { maxRetries: 0, maxFailures: 1, parallelExecution: true, maxParallel: 3 },
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    executor.enqueue(task, new AbortController().signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(task.id, "Goal aborted");
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Verify 4 options were presented
    expect(mockChannel.requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        options: ["Continue", "Always Continue", "Abort"],
      }),
    );
  });

  it("non-interactive channels auto-abort with text failure report", async () => {
    const goalTree = buildFailingGoalTree();
    const task = createTestTask(goalTree);
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Fails"));

    // LLM for recovery advisor returns RETRY
    mockAIProvider.chat.mockResolvedValue({ text: "RETRY" });

    // No interactive channel (channel=undefined)
    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: undefined,
      goalConfig: { maxFailures: 1, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
      goalExecutorConfig: { maxRetries: 0, maxFailures: 1, parallelExecution: true, maxParallel: 3 },
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const progressMessages: string[] = [];
    const onProgress = vi.fn((msg: string) => progressMessages.push(msg));
    executor.enqueue(task, new AbortController().signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(task.id, "Goal aborted");
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Should have reported failure via progress (no requestConfirmation)
    const hasFailureReport = progressMessages.some(m => m.includes("Failure budget exceeded") || m.includes("Aborting"));
    expect(hasFailureReport).toBe(true);
  });

  it("auto-abort fires after escalationTimeoutMinutes with notification", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const rootId = generateGoalNodeId();
    const child1Id = generateGoalNodeId();
    const now = Date.now();
    const nodes = new Map<GoalNodeId, GoalNode>();
    nodes.set(rootId, {
      id: rootId, parentId: null, task: "Root",
      dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now,
    });
    nodes.set(child1Id, {
      id: child1Id, parentId: rootId, task: "Fail step",
      dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
    });
    const goalTree: GoalTree = {
      rootId, sessionId: "test", taskDescription: "Timeout test",
      nodes, createdAt: now,
    };

    const task = createTestTask(goalTree);
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Fails"));

    // LLM for recovery returns RETRY
    mockAIProvider.chat.mockResolvedValue({ text: "RETRY" });

    // Channel that never responds (simulates user not responding)
    const mockChannel = createMockInteractiveChannel();
    mockChannel.requestConfirmation.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: mockChannel as any,
      goalConfig: { maxFailures: 1, escalationTimeoutMinutes: 1, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
      goalExecutorConfig: { maxRetries: 0, maxFailures: 1, parallelExecution: true, maxParallel: 3 },
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    executor.enqueue(task, new AbortController().signal, onProgress);

    // Advance time past the timeout (1 minute = 60000ms)
    await vi.advanceTimersByTimeAsync(65_000);

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(task.id, "Goal aborted");
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Should have sent auto-abort notification
    expect(mockChannel.sendText).toHaveBeenCalledWith(
      "chat1",
      expect.stringContaining("Auto-aborting"),
    );

    vi.useRealTimers();
  });

  it("'Always Continue' returns alwaysContinue: true", async () => {
    const rootId = generateGoalNodeId();
    const child1Id = generateGoalNodeId();
    const child2Id = generateGoalNodeId();
    const now = Date.now();
    const nodes = new Map<GoalNodeId, GoalNode>();
    nodes.set(rootId, {
      id: rootId, parentId: null, task: "Root",
      dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now,
    });
    nodes.set(child1Id, {
      id: child1Id, parentId: rootId, task: "Fail 1",
      dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
    });
    nodes.set(child2Id, {
      id: child2Id, parentId: rootId, task: "Ok step",
      dependsOn: [], depth: 1, status: "pending", createdAt: now, updatedAt: now,
    });
    const goalTree: GoalTree = {
      rootId, sessionId: "test", taskDescription: "Multi-node",
      nodes, createdAt: now,
    };

    const task = createTestTask(goalTree);
    let callCount = 0;
    mockOrch.runBackgroundTask.mockImplementation(async (prompt: string) => {
      callCount++;
      if (prompt.includes("Fail")) throw new Error("Fails");
      return "done";
    });

    const mockChannel = createMockInteractiveChannel();
    mockChannel.requestConfirmation.mockResolvedValue("Always Continue");
    mockAIProvider.chat.mockResolvedValue({ text: "RETRY" });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: mockAIProvider as any,
      channel: mockChannel as any,
      goalConfig: { maxFailures: 1, escalationTimeoutMinutes: 10, maxRedecompositions: 2 },
      learningEventBus: mockLearningBus as any,
      goalExecutorConfig: { maxRetries: 0, maxFailures: 1, parallelExecution: true, maxParallel: 3 },
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.fail).toHaveBeenCalledWith(
        task.id,
        expect.stringContaining("sub-goal(s) failed"),
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // requestConfirmation called only once (alwaysContinue skips subsequent calls)
    expect(mockChannel.requestConfirmation).toHaveBeenCalledTimes(1);
  });
});
