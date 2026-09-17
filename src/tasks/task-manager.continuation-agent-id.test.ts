/**
 * Every task continuation must carry the parent's `agentId`.
 *
 * Codex wave 0-A review 2026-09-17, finding #4 (plan item 0-A.x / 946efaa3):
 * `submit()` persisted `agentId`, but the seven continuation submit sites
 * (resumeTask, retryTask, retryGoalRoot ×2, replanGoalRoot, resumeGoalRoot ×2)
 * rebuilt their options by hand without it. The executor then booked the
 * child's spend as "chat" (`task.agentId ? "agent" : ...`), so a blocked agent
 * mission re-armed through retryTask bypassed the agent's allowance while
 * consuming the global wallet.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskManager } from "./task-manager.js";
import { TaskStorage } from "./task-storage.js";
import { TaskStatus, type Task } from "./types.js";
import { createLogger } from "../utils/logger.js";
import type { GoalNode, GoalTree, GoalNodeId } from "../goals/types.js";

const GOAL_ROOT = "goal_root";

function makeGoalTree(): GoalTree {
  const now = Date.now();
  const rootId = GOAL_ROOT as GoalNodeId;
  const failedNodeId = "goal_failed" as GoalNodeId;
  const nodes = new Map<GoalNodeId, GoalNode>([
    [rootId, {
      id: rootId,
      parentId: null,
      task: "Root",
      dependsOn: [],
      depth: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }],
    [failedNodeId, {
      id: failedNodeId,
      parentId: rootId,
      task: "Fix bug",
      dependsOn: [],
      depth: 1,
      status: "failed",
      error: "boom",
      createdAt: now,
      updatedAt: now,
    }],
  ]);
  return { rootId, sessionId: "chat-1", taskDescription: "Repair", nodes, createdAt: now };
}

function setup(opts: { withTree?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strada-continuation-agent-id-"));
  const storage = new TaskStorage(join(dir, "tasks.db"));
  storage.initialize();
  const executor = {
    enqueue: vi.fn(),
    resumeConversation: vi.fn(),
    pauseConversation: vi.fn(),
  } as any;
  const goalStorage = opts.withTree
    ? ({ getTree: vi.fn().mockReturnValue(makeGoalTree()) } as any)
    : undefined;
  const manager = new TaskManager(storage, executor, goalStorage);
  /** The task handed to the executor by the Nth submit (0 = the original). */
  const enqueued = (index: number): Task => executor.enqueue.mock.calls[index]?.[0] as Task;
  const cleanup = () => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { storage, executor, manager, enqueued, cleanup };
}

/** Both the enqueued task and its persisted row must name the agent. */
function expectAgent(s: ReturnType<typeof setup>, child: Task | null, index: number, agentId: string | undefined) {
  expect(child).not.toBeNull();
  const enqueued = s.enqueued(index);
  expect(enqueued.id).toBe(child!.id);
  expect(enqueued.agentId).toBe(agentId);
  expect(s.storage.load(child!.id)?.agentId).toBe(agentId);
}

describe("task continuations keep the parent's agentId", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-task-manager-continuation-agent-id-test.log"); } catch { /* already initialized */ }
  });

  it("retryTask after a block", () => {
    const s = setup();
    try {
      const task = s.manager.submit("chat-1", "cli", "agent A's mission", { agentId: "A" });
      expect(s.storage.load(task.id)?.agentId).toBe("A");
      s.manager.block(task.id, "Transient failure — provider blink.");

      const retry = s.manager.retryTask(task.id);
      expectAgent(s, retry, 1, "A");
      expect(retry!.parentId).toBe(task.id);
    } finally {
      s.cleanup();
    }
  });

  it("resumeTask after a pause", () => {
    const s = setup();
    try {
      const task = s.manager.submit("chat-1", "cli", "agent A's mission", { agentId: "A" });
      s.manager.updateStatus(task.id, TaskStatus.executing);
      expect(s.manager.pauseTask(task.id)).toBe(true);

      const resumed = s.manager.resumeTask(task.id);
      expectAgent(s, resumed, 1, "A");
    } finally {
      s.cleanup();
    }
  });

  it("retryGoalRoot / replanGoalRoot / resumeGoalRoot with a stored tree", () => {
    const s = setup({ withTree: true });
    try {
      const task = s.manager.submit("chat-1", "cli", "agent A's goal", {
        agentId: "A",
        goalRootId: GOAL_ROOT,
        goalTree: makeGoalTree(),
      });
      s.manager.block(task.id, "Transient failure — blink.");

      const retry = s.manager.retryGoalRoot(GOAL_ROOT);
      expectAgent(s, retry, 1, "A");
      expect(retry!.goalTree).toBeDefined();

      s.manager.block(retry!.id, "Transient failure — blink.");
      const replan = s.manager.replanGoalRoot(GOAL_ROOT, ["x"]);
      expectAgent(s, replan, 2, "A");

      s.manager.updateStatus(replan!.id, TaskStatus.executing);
      expect(s.manager.pauseTask(replan!.id)).toBe(true);
      const resumed = s.manager.resumeGoalRoot(GOAL_ROOT);
      expectAgent(s, resumed, 3, "A");
      expect(resumed!.goalTree).toBeDefined();
    } finally {
      s.cleanup();
    }
  });

  it("retryGoalRoot / resumeGoalRoot without a stored tree (replay fallbacks)", () => {
    const s = setup();
    try {
      const task = s.manager.submit("chat-1", "cli", "agent A's goal", {
        agentId: "A",
        goalRootId: GOAL_ROOT,
      });
      s.manager.block(task.id, "Transient failure — blink.");

      const retry = s.manager.retryGoalRoot(GOAL_ROOT);
      expectAgent(s, retry, 1, "A");
      expect(retry!.goalTree).toBeUndefined();

      s.manager.updateStatus(retry!.id, TaskStatus.executing);
      expect(s.manager.pauseTask(retry!.id)).toBe(true);
      const resumed = s.manager.resumeGoalRoot(GOAL_ROOT);
      expectAgent(s, resumed, 2, "A");
      expect(resumed!.goalTree).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it("replanGoalRoot without a stored tree", () => {
    const s = setup();
    try {
      const task = s.manager.submit("chat-1", "cli", "agent A's goal", {
        agentId: "A",
        goalRootId: GOAL_ROOT,
      });
      s.manager.block(task.id, "Transient failure — blink.");

      const replan = s.manager.replanGoalRoot(GOAL_ROOT, ["x"]);
      expectAgent(s, replan, 1, "A");
    } finally {
      s.cleanup();
    }
  });

  it("does not invent attribution: a task without an agentId continues without one", () => {
    const s = setup({ withTree: true });
    try {
      const plain = s.manager.submit("chat-1", "cli", "a person's chat task");
      s.manager.block(plain.id, "Transient failure — blink.");
      const retry = s.manager.retryTask(plain.id);
      expectAgent(s, retry, 1, undefined);

      const goal = s.manager.submit("chat-1", "cli", "a person's goal", {
        goalRootId: GOAL_ROOT,
        goalTree: makeGoalTree(),
      });
      s.manager.block(goal.id, "Transient failure — blink.");
      const goalRetry = s.manager.retryGoalRoot(GOAL_ROOT);
      expectAgent(s, goalRetry, 3, undefined);
    } finally {
      s.cleanup();
    }
  });
});
