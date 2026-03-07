/**
 * Background Executor
 *
 * Async execution queue for running tasks in the background.
 * Uses a FIFO queue with configurable concurrency limit.
 * All work is I/O-bound (LLM API calls), so same event loop is fine.
 *
 * Optionally accepts a TaskDecomposer to break complex prompts
 * into ordered subtasks before execution.
 */

import type { Task } from "./types.js";
import { TaskStatus } from "./types.js";
import type { TaskManager } from "./task-manager.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import type { GoalNode, GoalNodeId } from "../goals/types.js";
import { getLogger } from "../utils/logger.js";

interface QueueEntry {
  task: Task;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export class BackgroundExecutor {
  private readonly queue: QueueEntry[] = [];
  private running = 0;
  private taskManager: TaskManager | null = null;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly concurrencyLimit: number = 3,
    private readonly decomposer?: GoalDecomposer,
  ) {}

  /**
   * Set the task manager reference (avoids circular dependency).
   */
  setTaskManager(manager: TaskManager): void {
    this.taskManager = manager;
  }

  /**
   * Add a task to the execution queue.
   */
  enqueue(task: Task, signal: AbortSignal, onProgress: (message: string) => void): void {
    this.queue.push({ task, signal, onProgress });
    this.processQueue();
  }

  /**
   * Process the queue, starting tasks up to the concurrency limit.
   */
  private processQueue(): void {
    while (this.running < this.concurrencyLimit && this.queue.length > 0) {
      const entry = this.queue.shift()!;

      // Skip if already cancelled
      if (entry.signal.aborted) {
        continue;
      }

      this.running++;
      this.executeTask(entry).finally(() => {
        this.running--;
        this.processQueue();
      });
    }
  }

  private async executeTask(entry: QueueEntry): Promise<void> {
    const { task, signal, onProgress } = entry;
    const logger = getLogger();

    if (!this.taskManager) {
      logger.error("TaskManager not set on BackgroundExecutor");
      return;
    }

    // Update status to executing
    this.taskManager.updateStatus(task.id, TaskStatus.executing);
    onProgress("Task started");

    try {
      // Check if task should be decomposed into subtasks
      if (this.decomposer?.shouldDecompose(task.prompt)) {
        const result = await this.executeDecomposed(task, signal, onProgress);
        if (signal.aborted) return;
        this.taskManager.complete(task.id, result);
        return;
      }

      const result = await this.orchestrator.runBackgroundTask(task.prompt, {
        signal,
        onProgress,
        chatId: task.chatId,
        channelType: task.channelType,
      });

      if (signal.aborted) {
        // Already cancelled — don't overwrite the cancelled status
        return;
      }

      this.taskManager.complete(task.id, result);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Background task execution error", { taskId: task.id, error: errMsg });
      this.taskManager.fail(task.id, errMsg);
    }
  }

  /**
   * Decompose a task into a goal tree, execute nodes in topological order, and combine results.
   * Phase 7: sequential execution; Phase 8 will add parallel execution with GOAL-06.
   */
  private async executeDecomposed(
    task: Task,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<string> {
    const logger = getLogger();
    const { renderGoalTree } = await import("../goals/goal-renderer.js");
    const goalTree = await this.decomposer!.decomposeProactive(task.chatId, task.prompt);
    const nodes: GoalNode[] = Array.from(goalTree.nodes.values());

    // Extract topological order: nodes with all deps completed, excluding root
    const nonRootNodes = nodes.filter((n) => n.id !== goalTree.rootId);
    const sortedNodes = this.topologicalSort(nonRootNodes);

    logger.info("Task decomposed into goal tree", { taskId: task.id, nodeCount: sortedNodes.length });
    onProgress(`Decomposed into ${sortedNodes.length} sub-goals`);
    onProgress(renderGoalTree(goalTree));

    const results: string[] = [];
    const completedNodeIds = new Set<GoalNodeId>();
    // Mutable copy for status tracking
    const mutableNodes = new Map(goalTree.nodes);

    for (let i = 0; i < sortedNodes.length; i++) {
      if (signal.aborted) return "";

      const node = sortedNodes[i]!;

      // Check all dependencies are completed
      const depsReady = node.dependsOn.every((depId) => completedNodeIds.has(depId));
      if (!depsReady) {
        // Skip this node -- deps not met (node failed or skipped)
        mutableNodes.set(node.id, { ...node, status: "skipped" as const, updatedAt: Date.now() });
        continue;
      }

      // Mark as executing
      mutableNodes.set(node.id, { ...node, status: "executing" as const, updatedAt: Date.now() });
      onProgress(`Sub-goal ${i + 1}/${sortedNodes.length}: ${node.task}`);

      try {
        const result = await this.orchestrator.runBackgroundTask(node.task, {
          signal,
          onProgress: (msg: string) => onProgress(`[${i + 1}/${sortedNodes.length}] ${msg}`),
          chatId: task.chatId,
          channelType: task.channelType,
        });

        mutableNodes.set(node.id, { ...node, status: "completed" as const, result, updatedAt: Date.now() });
        completedNodeIds.add(node.id);
        results.push(`## Sub-goal ${i + 1}: ${node.task}\n\n${result}`);
      } catch (nodeError) {
        const errMsg = nodeError instanceof Error ? nodeError.message : String(nodeError);
        mutableNodes.set(node.id, { ...node, status: "failed" as const, error: errMsg, updatedAt: Date.now() });
        logger.warn("Sub-goal execution failed, stopping remaining", { taskId: task.id, nodeId: node.id, error: errMsg });
        // Stop remaining sub-goals on failure (Phase 8 may refine this)
        break;
      }

      // Show updated tree on progress
      const updatedTree = { ...goalTree, nodes: mutableNodes };
      onProgress(renderGoalTree(updatedTree));
    }

    return results.join("\n\n---\n\n");
  }

  /**
   * Topological sort of goal nodes using Kahn's algorithm.
   * Returns nodes in dependency order (independent nodes first).
   */
  private topologicalSort(nodes: GoalNode[]): GoalNode[] {
    const inDegree = new Map<GoalNodeId, number>();
    const adjacency = new Map<GoalNodeId, GoalNodeId[]>();
    const nodeMap = new Map<GoalNodeId, GoalNode>();

    for (const node of nodes) {
      nodeMap.set(node.id, node);
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        if (nodeMap.has(dep)) {
          inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
          adjacency.get(dep)?.push(node.id);
        }
      }
    }

    // Start with zero in-degree nodes (sorted by creation time for stability)
    const queue: GoalNode[] = nodes
      .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
      .sort((a, b) => a.createdAt - b.createdAt);

    const sorted: GoalNode[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const nextId of adjacency.get(current.id) ?? []) {
        const newDeg = (inDegree.get(nextId) ?? 1) - 1;
        inDegree.set(nextId, newDeg);
        if (newDeg === 0) {
          const nextNode = nodeMap.get(nextId);
          if (nextNode) queue.push(nextNode);
        }
      }
    }

    return sorted;
  }
}
