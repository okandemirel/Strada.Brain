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

function createTestTask(goalTree?: GoalTree): Task {
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

    // Decomposer.decomposeProactive SHOULD have been called
    expect(mockDecomposer.decomposeProactive).toHaveBeenCalled();
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
});
