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
  const evaluateSupervisorAdmission = vi.fn().mockResolvedValue({
    path: "direct_worker",
    reason: "low_complexity",
  });
  return {
    evaluateSupervisorAdmission,
    tryRouteThroughSupervisor: evaluateSupervisorAdmission,
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
    updateTreeStatus: vi.fn(),
  };
}

function createMockDaemonEventBus() {
  return {
    emit: vi.fn(),
  };
}

function createMockWorkspaceBus() {
  return {
    emit: vi.fn(),
  };
}

function createMockMonitorLifecycle() {
  return {
    requestStart: vi.fn(),
    goalDecomposed: vi.fn(),
    goalRestructured: vi.fn(),
    requestEnd: vi.fn(),
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
  let mockWorkspaceBus: ReturnType<typeof createMockWorkspaceBus>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    mockDecomposer = createMockDecomposer();
    mockGoalStorage = createMockGoalStorage();
    mockDaemonEventBus = createMockDaemonEventBus();
    mockWorkspaceBus = createMockWorkspaceBus();
  });

  it("routes pre-decomposed goalTree through supervisor when available", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "supervisor",
      reason: "eligible",
      result: {
        success: true,
        partial: false,
        output: "supervisor task done",
        totalNodes: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalDuration: 0,
        nodeResults: [],
      },
    });

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
      block: vi.fn(),
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
    expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor task done");
    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree,
      }),
    );
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("routes top-level complex tasks through supervisor even without a prebuilt goal tree", async () => {
    const task = createTestTask(undefined, {
      prompt: "Audit the architecture, split the work across providers, and reconcile the findings",
    });
    mockDecomposer.shouldDecompose.mockReturnValue(false);
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "supervisor",
      reason: "eligible",
      result: {
        success: true,
        partial: false,
        output: "supervisor handled complex task",
        totalNodes: 3,
        succeeded: 3,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalDuration: 0,
        nodeResults: [],
      },
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor handled complex task");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree: undefined,
        // forceEligibility removed — supervisor always applies its own complexity gate
        taskRunId: task.id,
      }),
    );
    expect(mockOrch.runBackgroundTask).not.toHaveBeenCalled();
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("keeps image-backed queued goal tasks on the shared supervisor path when admission succeeds", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree, {
      attachments: [{
        type: "image",
        name: "layout.png",
        mimeType: "image/png",
        data: Buffer.from("png-data"),
        size: 8,
      }],
    });
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "supervisor",
      reason: "eligible",
      result: {
        success: true,
        partial: false,
        output: "supervisor handled image-backed goal",
        totalNodes: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalDuration: 0,
        nodeResults: [],
      },
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor handled image-backed goal");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree,
        attachments: task.attachments,
        // forceEligibility removed — supervisor always applies its own complexity gate
        taskRunId: task.id,
      }),
    );
    expect(mockOrch.runBackgroundTask).not.toHaveBeenCalled();
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    expect(mockTaskManager.block).not.toHaveBeenCalled();
  });

  it("falls back to a direct worker for rich-input goal trees when supervisor declines them", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree, {
      attachments: [{
        type: "image",
        name: "layout.png",
        mimeType: "image/png",
        data: Buffer.from("png-data"),
        size: 8,
      }],
    });
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "direct_worker",
      reason: "busy",
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "task done");
    }, { timeout: 5000 });

    expect(mockOrch.runBackgroundTask).toHaveBeenCalledWith(
      task.prompt,
      expect.objectContaining({
        attachments: task.attachments,
        supervisorMode: "off",
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledTimes(1);
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    expect(mockTaskManager.block).not.toHaveBeenCalled();
  });

  it("blocks queued goal tasks when supervisor returns a partial result", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);
    mockOrch.evaluateSupervisorAdmission.mockImplementation(async (params: { onGoalDecomposed?: (goalTree: GoalTree) => void }) => {
      params.onGoalDecomposed?.(goalTree);
      return {
        path: "supervisor",
        reason: "eligible",
        result: {
          success: false,
          partial: true,
          output: "Completed:\nstep 1\n\nSkipped:\n[step-2] skipped",
          totalNodes: 2,
          succeeded: 1,
          failed: 0,
          skipped: 1,
          totalCost: 0,
          totalDuration: 0,
          nodeResults: [],
        },
      };
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.block).toHaveBeenCalledWith(task.id, "Completed:\nstep 1\n\nSkipped:\n[step-2] skipped");
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:failed",
      expect.objectContaining({
        rootId: goalTree.rootId,
        error: "Goal execution blocked",
      }),
    );
  });

  it("keeps queued supervisor monitor lifecycle on the conversation scope", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree, {
      chatId: "chat-monitor",
      conversationId: "thread-7",
    });
    const monitorLifecycle = createMockMonitorLifecycle();
    mockOrch.evaluateSupervisorAdmission.mockImplementation(async (params: { onGoalDecomposed?: (goalTree: GoalTree) => void }) => {
      params.onGoalDecomposed?.(goalTree);
      return {
        path: "supervisor",
        reason: "eligible",
        result: {
          success: true,
          partial: false,
          output: "supervisor task done",
          totalNodes: 2,
          succeeded: 2,
          failed: 0,
          skipped: 0,
          totalCost: 0,
          totalDuration: 0,
          nodeResults: [],
        },
      };
    });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });
    executor.setMonitorLifecycle(monitorLifecycle as any);

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor task done");
    }, { timeout: 5000 });

    expect(monitorLifecycle.requestStart).toHaveBeenCalledWith("thread-7", task.prompt);
    expect(monitorLifecycle.goalDecomposed).toHaveBeenCalledWith("thread-7", goalTree);
    expect(monitorLifecycle.requestEnd).toHaveBeenCalledWith("thread-7", false);
  });

  it("emits goal lifecycle events for queued supervisor executions", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);
    mockOrch.evaluateSupervisorAdmission.mockImplementation(async (params: { onGoalDecomposed?: (goalTree: GoalTree) => void }) => {
      params.onGoalDecomposed?.(goalTree);
      return {
        path: "supervisor",
        reason: "eligible",
        result: {
          success: true,
          partial: false,
          output: "supervisor task done",
          totalNodes: 2,
          succeeded: 2,
          failed: 0,
          skipped: 0,
          totalCost: 0,
          totalDuration: 0,
          nodeResults: [],
        },
      };
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor task done");
    }, { timeout: 5000 });

    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:started",
      expect.objectContaining({
        rootId: goalTree.rootId,
        taskDescription: goalTree.taskDescription,
      }),
    );
    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:complete",
      expect.objectContaining({
        rootId: goalTree.rootId,
        taskDescription: goalTree.taskDescription,
        successCount: 2,
      }),
    );
  });

  it("routes to direct_worker when task has no goalTree even if shouldDecompose returns true", async () => {
    // Without a pre-built goalTree, tasks should go through the direct worker path
    // (PAOR loop) instead of being decomposed into goal nodes — this prevents
    // simple messages from being split into dozens of sub-tasks.
    const task = createTestTask(); // no goalTree

    mockDecomposer.shouldDecompose.mockReturnValue(true);

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const onProgress = vi.fn();
    const ac = new AbortController();
    executor.enqueue(task, ac.signal, onProgress);

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    // Supervisor admission is still evaluated
    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalled();
    // But decomposer.decomposeProactive should NOT have been called —
    // only pre-built goalTree triggers inline goal execution
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
    // Instead, the direct worker path (runBackgroundTask) should run
    expect(mockOrch.runBackgroundTask).toHaveBeenCalled();
  });

  it("defers runnable daemon queue entries while foreground work is active", () => {
    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      aiProvider: undefined,
      channel: undefined,
    });
    const taskManager = {
      hasActiveForegroundTasks: vi.fn().mockReturnValue(true),
    };
    executor.setTaskManager(taskManager as any);

    (executor as any).queue.push(
      {
        task: createTestTask(undefined, { id: "task_daemon" as Task["id"], origin: "daemon", chatId: "daemon", channelType: "daemon" }),
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      },
      {
        task: createTestTask(undefined, { id: "task_user" as Task["id"], origin: "user", chatId: "chat-user", channelType: "cli" }),
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      },
    );

    expect((executor as any).findNextRunnableIndex()).toBe(1);

    (executor as any).queue.splice(1, 1);
    expect((executor as any).findNextRunnableIndex()).toBe(-1);
  });

  it("re-enters shared planning for rich-input tasks that were goal-planned without a persisted tree", async () => {
    const task = createTestTask(undefined, {
      prompt: "Inspect this screenshot and explain the layout bug",
      forceSharedPlanning: true,
      attachments: [{
        type: "image",
        name: "layout.png",
        mimeType: "image/png",
        data: Buffer.from("png-data"),
        size: 8,
      }],
    });

    mockDecomposer.shouldDecompose.mockReturnValue(false);
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "supervisor",
      reason: "eligible",
      result: {
        success: true,
        partial: false,
        output: "supervisor handled grounded rich task",
        totalNodes: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalDuration: 0,
        nodeResults: [],
      },
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor handled grounded rich task");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree: undefined,
        // forceEligibility removed — supervisor always applies its own complexity gate
        attachments: task.attachments,
        taskRunId: task.id,
      }),
    );
    expect(mockOrch.runBackgroundTask).not.toHaveBeenCalled();
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("preserves queued multimodal userContent when rich input has no attachment mirror", async () => {
    const task = createTestTask(undefined, {
      prompt: "Inspect this screenshot and explain the layout bug",
      forceSharedPlanning: true,
      userContent: [
        { type: "text", text: "Inspect this screenshot and explain the layout bug" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: Buffer.from("png-data").toString("base64"),
          },
        },
      ],
    });

    mockDecomposer.shouldDecompose.mockReturnValue(false);
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "direct_worker",
      reason: "multimodal_passthrough",
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "task done");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: task.userContent,
        attachments: undefined,
        // forceEligibility removed — supervisor always applies its own complexity gate
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledWith(
      task.prompt,
      expect.objectContaining({
        userContent: task.userContent,
        supervisorMode: "off",
      }),
    );
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("falls back to direct worker when supervisor declines a pre-decomposed goalTree", async () => {
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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "task done");
    }, { timeout: 5000 });

    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree,
      }),
    );
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
    // With direct_goal_execution removed, the task goes through direct_worker
    expect(mockOrch.runBackgroundTask).toHaveBeenCalled();
  });

  it("keeps image-backed goal tasks on the direct worker path when supervisor declines them", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree, {
      attachments: [{
        type: "image",
        name: "layout.png",
        mimeType: "image/png",
        data: Buffer.from("png"),
        size: 3,
      }],
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "task done");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree,
        attachments: task.attachments,
        // forceEligibility removed — supervisor always applies its own complexity gate
        taskRunId: task.id,
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledWith(
      task.prompt,
      expect.objectContaining({
        attachments: task.attachments,
        supervisorMode: "off",
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledTimes(1);
  });

  it("routes queued pre-decomposed tasks through supervisor before inline goal execution", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "supervisor",
      reason: "eligible",
      result: {
        success: true,
        partial: false,
        output: "supervisor handled queued task",
        totalNodes: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalDuration: 0,
        nodeResults: [],
      },
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor handled queued task");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree,
        // forceEligibility removed — supervisor always applies its own complexity gate
      }),
    );
    expect(mockOrch.runBackgroundTask).not.toHaveBeenCalled();
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
    expect(mockTaskManager.block).not.toHaveBeenCalled();
  });

  it("acquires a task-scoped workspace before queued supervisor routing and releases it after completion", async () => {
    const goalTree = buildTestGoalTree();
    const release = vi.fn().mockResolvedValue(undefined);
    const workspaceLease = {
      id: "lease-task",
      path: "/tmp/task-lease",
      release,
    };
    const acquireLease = vi.fn().mockResolvedValue(workspaceLease);
    const task = createTestTask(goalTree, {
      attachments: [{
        type: "image",
        name: "layout.png",
        mimeType: "image/png",
        data: Buffer.from("png"),
        size: 3,
      }],
    });
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "direct_worker",
      reason: "fallback",
    });

    const executor = new BackgroundExecutor({
      orchestrator: mockOrch as any,
      decomposer: mockDecomposer as any,
      goalStorage: mockGoalStorage as any,
      daemonEventBus: mockDaemonEventBus as any,
      workspaceLeaseManager: {
        acquireLease,
      } as any,
      aiProvider: undefined,
      channel: undefined,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "task done");
    }, { timeout: 5000 });

    expect(acquireLease).toHaveBeenCalledWith({
      label: `task-${task.id}`,
      workerId: String(task.id),
    });
    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceLease,
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledWith(
      task.prompt,
      expect.objectContaining({
        workspaceLease,
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("routes queued decomposable tasks through supervisor before calling the decomposer", async () => {
    const task = createTestTask();
    mockDecomposer.shouldDecompose.mockReturnValue(true);
    mockOrch.evaluateSupervisorAdmission.mockResolvedValue({
      path: "supervisor",
      reason: "eligible",
      result: {
        success: true,
        partial: false,
        output: "supervisor handled decomposable task",
        totalNodes: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalDuration: 0,
        nodeResults: [],
      },
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "supervisor handled decomposable task");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        // forceEligibility removed — supervisor always applies its own complexity gate
      }),
    );
    expect(mockDecomposer.decomposeProactive).not.toHaveBeenCalled();
    expect(mockOrch.runBackgroundTask).not.toHaveBeenCalled();
  });

  it("keeps vision-backed queued tasks on the direct worker path instead of executing the prebuilt tree", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree, {
      attachments: [{
        type: "image",
        name: "design.png",
        mimeType: "image/png",
        data: Buffer.from("png-data"),
        size: 8,
      }],
    });

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
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    executor.enqueue(task, new AbortController().signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.complete).toHaveBeenCalledWith(task.id, "task done");
    }, { timeout: 5000 });

    expect(mockOrch.evaluateSupervisorAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: task.prompt,
        goalTree,
        attachments: task.attachments,
        // forceEligibility removed — supervisor always applies its own complexity gate
        taskRunId: task.id,
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledWith(
      task.prompt,
      expect.objectContaining({
        attachments: task.attachments,
        supervisorMode: "off",
      }),
    );
    expect(mockOrch.runBackgroundTask).toHaveBeenCalledTimes(1);
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
    expect(onProgress).not.toHaveBeenCalled();
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

  it("reuses the shared worker envelope for delegated runs and releases acquired leases", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const workspaceLease = {
      id: "lease-1",
      workspaceId: "ws-1",
      release,
    };
    const acquireLease = vi.fn().mockResolvedValue(workspaceLease);
    const usageRecorder = vi.fn();
    const attachments = [{
      type: "image",
      name: "layout.png",
      mimeType: "image/png",
      data: Buffer.from("png"),
      size: 3,
    }];
    const runWorkerTask = vi.fn().mockResolvedValue({
      status: "completed",
      finalSummary: "delegated ok",
      visibleResponse: "delegated ok",
      provider: "mock",
      catalogVersion: "mock:default",
      assignmentVersion: 0,
      touchedFiles: [],
      toolTrace: [],
      verificationResults: [],
      reviewFindings: [],
      artifacts: [],
    });
    const workerOrchestrator = { runWorkerTask } as any;
    const executor = new BackgroundExecutor({
      orchestrator: workerOrchestrator,
      workspaceLeaseManager: {
        acquireLease,
      } as any,
    });

    const result = await executor.runWorkerEnvelope(workerOrchestrator, {
      mode: "delegated",
      prompt: "Inspect delegated node",
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "chat1",
      taskRunId: "task_test123:node1",
      channelType: "web",
      conversationId: "thread-1",
      userId: "user-1",
      attachments,
      onUsage: usageRecorder,
      workspaceSourceRoot: "/tmp/parent-workspace",
      supervisorMode: "off",
    });

    expect(acquireLease).toHaveBeenCalledWith({
      label: "delegated-worker-task_test123:node1",
      workerId: "task_test123:node1",
      sourceRoot: "/tmp/parent-workspace",
      forceTempCopy: true,
    });
    expect(runWorkerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "delegated",
        prompt: "Inspect delegated node",
        chatId: "chat1",
        taskRunId: "task_test123:node1",
        channelType: "web",
        conversationId: "thread-1",
        userId: "user-1",
        attachments,
        onUsage: usageRecorder,
        workspaceLease,
        supervisorMode: "off",
      }),
    );
    expect(result.output).toBe("delegated ok");
    expect(result.workerResult?.visibleResponse).toBe("delegated ok");
    expect(release).toHaveBeenCalledTimes(1);
  });

});

describe("BackgroundExecutor - Blocked worker results", () => {
  it("marks the root task blocked when a worker returns blocked", async () => {
    const executor = new BackgroundExecutor({
      orchestrator: {
        runWorkerTask: vi.fn().mockResolvedValue({
          status: "blocked",
          finalSummary: "Need a fresh diagnosis",
          visibleResponse: "Checkpoint",
          provider: "mock",
          catalogVersion: "mock:default",
          assignmentVersion: 0,
          touchedFiles: [],
          toolTrace: [],
          verificationResults: [],
          reviewFindings: [],
          artifacts: [],
          reason: "Need a fresh diagnosis",
        }),
      } as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const ac = new AbortController();
    executor.enqueue(createTestTask(), ac.signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.block).toHaveBeenCalledWith(
        "task_test123",
        "Need a fresh diagnosis",
      );
    });
    expect(mockTaskManager.complete).not.toHaveBeenCalled();
    expect(mockTaskManager.fail).not.toHaveBeenCalled();
  });

  it("marks decomposed tasks blocked when a child worker returns blocked", async () => {
    const goalTree = buildTestGoalTree();
    const executor = new BackgroundExecutor({
      orchestrator: {
        runWorkerTask: vi.fn().mockResolvedValue({
          status: "blocked",
          finalSummary: "Verifier loop needs external diagnosis",
          visibleResponse: "Verifier loop needs external diagnosis",
          provider: "mock",
          catalogVersion: "mock:default",
          assignmentVersion: 0,
          touchedFiles: ["Assets/Game/GameController.cs"],
          toolTrace: [],
          verificationResults: [],
          reviewFindings: [],
          artifacts: [],
          reason: "Verifier loop needs external diagnosis",
        }),
      } as any,
    });

    const mockTaskManager = {
      updateStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      block: vi.fn(),
    };
    executor.setTaskManager(mockTaskManager as any);

    const ac = new AbortController();
    executor.enqueue(createTestTask(goalTree), ac.signal, vi.fn());

    await vi.waitFor(() => {
      expect(mockTaskManager.block).toHaveBeenCalledWith(
        "task_test123",
        expect.stringContaining("Verifier loop needs external diagnosis"),
      );
    });
    expect(mockTaskManager.complete).not.toHaveBeenCalled();
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

  it("emits goal:failed event when direct worker fails and task has goalTree", async () => {
    const goalTree = buildTestGoalTree();
    const task = createTestTask(goalTree);

    // Make the orchestrator fail
    mockOrch.runBackgroundTask.mockRejectedValue(new Error("Node failed"));

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
      expect(mockTaskManager.fail).toHaveBeenCalledWith(
        task.id,
        "Node failed",
      );
    }, { timeout: 5000 });

    expect(mockTaskManager.complete).not.toHaveBeenCalled();

    // Should have emitted goal:failed via the catch path (task.goalTree exists)
    expect(mockDaemonEventBus.emit).toHaveBeenCalledWith(
      "goal:failed",
      expect.objectContaining({
        rootId: goalTree.rootId,
        error: "Node failed",
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
});

