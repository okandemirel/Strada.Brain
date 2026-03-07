/**
 * Goal Executor
 *
 * Wave-based parallel DAG execution engine with:
 * - Semaphore-based concurrency limiting (GOAL_MAX_PARALLEL)
 * - Failure budgets with user-facing continuation options (GOAL_MAX_FAILURES)
 * - LLM criticality evaluation for failure propagation decisions
 * - Retry logic (GOAL_MAX_RETRIES) per node
 * - Per-node timing (startedAt, completedAt)
 * - AbortSignal support for cancellation
 *
 * Replaces BackgroundExecutor's sequential executeDecomposed() with a proper
 * parallel executor that respects dependency edges, tracks progress, and
 * handles failures gracefully.
 */

import type { GoalTree, GoalNode, GoalNodeId } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface FailedNodeInfo {
  nodeId: GoalNodeId;
  task: string;
  error: string;
  retryCount: number;
}

export interface FailureReport {
  tree: GoalTree;
  failedNodes: FailedNodeInfo[];
  failureCount: number;
  maxFailures: number;
}

export interface FailureBudgetDecision {
  continue: boolean;
  alwaysContinue: boolean;
}

export interface ExecutionResult {
  tree: GoalTree;
  results: Array<{ nodeId: GoalNodeId; task: string; result?: string; error?: string }>;
  totalDurationMs: number;
  failureCount: number;
  aborted: boolean;
}

export interface GoalExecutorConfig {
  maxRetries: number;
  maxFailures: number;
  parallelExecution: boolean;
  maxParallel: number;
}

/** Executes a single node's task. Injected by BackgroundExecutor. */
export type NodeExecutor = (node: GoalNode, signal: AbortSignal) => Promise<string>;

/** Called on every node status change (for persistence + progress updates). */
export type OnNodeStatusChange = (tree: GoalTree, node: GoalNode) => void;

/**
 * LLM criticality evaluator: determines if a child's failure should block dependent nodes.
 * Returns true if the failure IS critical (dependents should be skipped),
 * false if NOT critical (dependents can proceed).
 * If not provided, all failures are treated as critical (dependents skipped).
 */
export type CriticalityEvaluator = (
  failedNode: GoalNode,
  parentTask: string,
) => Promise<boolean>;

/**
 * Called when failure budget is exceeded.
 * Returns { continue, alwaysContinue }. If not provided, execution aborts.
 */
export type OnFailureBudgetExceeded = (report: FailureReport) => Promise<FailureBudgetDecision>;

// =============================================================================
// SEMAPHORE
// =============================================================================

/**
 * Queue-based semaphore for limiting concurrent async operations.
 * When the limit is reached, subsequent acquire() calls block until
 * a running operation completes.
 */
export class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        this.queue.shift()!();
      }
    }
  }
}

// =============================================================================
// GOAL EXECUTOR
// =============================================================================

export class GoalExecutor {
  constructor(private readonly config: GoalExecutorConfig) {}

  async executeTree(
    tree: GoalTree,
    executor: NodeExecutor,
    signal: AbortSignal,
    opts?: {
      onStatusChange?: OnNodeStatusChange;
      criticalityEvaluator?: CriticalityEvaluator;
      onFailureBudgetExceeded?: OnFailureBudgetExceeded;
    },
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Mutable copy of nodes
    const mutableNodes = new Map<GoalNodeId, GoalNode>();
    for (const [id, node] of tree.nodes) {
      mutableNodes.set(id, { ...node });
    }

    // Tracking sets
    const completedIds = new Set<GoalNodeId>();
    const failedIds = new Set<GoalNodeId>();
    const skippedIds = new Set<GoalNodeId>();
    const nonCriticalFailedIds = new Set<GoalNodeId>();
    const failedNodeInfos: FailedNodeInfo[] = [];
    const results: ExecutionResult["results"] = [];
    let failureCount = 0;
    let alwaysContinue = false;
    let aborted = false;

    // Pre-populate completedIds with already-completed nodes (including root)
    for (const [id, node] of mutableNodes) {
      if (node.status === "completed") {
        completedIds.add(id);
      }
    }

    // Create semaphore
    const semaphore = new Semaphore(this.config.maxParallel);

    // Helper: build current tree state for callbacks
    const buildTree = (): GoalTree => ({
      ...tree,
      nodes: new Map(mutableNodes),
    });

    // Helper: update a node in mutableNodes and fire callback
    const updateNode = (
      nodeId: GoalNodeId,
      updates: Partial<GoalNode>,
    ): GoalNode => {
      const current = mutableNodes.get(nodeId)!;
      const updated: GoalNode = {
        ...current,
        ...updates,
        updatedAt: Date.now(),
      };
      mutableNodes.set(nodeId, updated);
      opts?.onStatusChange?.(buildTree(), updated);
      return updated;
    };

    // Helper: check if a node has dependents (other nodes that depend on it)
    const hasDependents = (nodeId: GoalNodeId): boolean => {
      for (const [id, node] of mutableNodes) {
        if (id === tree.rootId) continue;
        if (node.dependsOn.includes(nodeId)) return true;
      }
      return false;
    };

    // Helper: get the parent task string for criticality evaluation
    const getParentTask = (nodeId: GoalNodeId): string => {
      const node = mutableNodes.get(nodeId);
      if (node?.parentId) {
        const parent = mutableNodes.get(node.parentId);
        if (parent) return parent.task;
      }
      return tree.taskDescription;
    };

    // Helper: execute a single node with retries
    const executeNode = async (nodeId: GoalNodeId): Promise<void> => {
      const node = mutableNodes.get(nodeId)!;
      let retryCount = 0;

      // Set to executing
      updateNode(nodeId, {
        status: "executing" as const,
        startedAt: Date.now(),
      });

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          const result = await executor(mutableNodes.get(nodeId)!, signal);

          // Success
          updateNode(nodeId, {
            status: "completed" as const,
            result,
            completedAt: Date.now(),
            retryCount,
          });
          completedIds.add(nodeId);
          results.push({ nodeId, task: node.task, result });
          return;
        } catch (err) {
          retryCount = attempt + 1;
          if (attempt < this.config.maxRetries) {
            // Update retryCount for the next attempt
            updateNode(nodeId, { retryCount });
            continue;
          }

          // Final failure after all retries exhausted
          const error = err instanceof Error ? err.message : String(err);
          updateNode(nodeId, {
            status: "failed" as const,
            error,
            completedAt: Date.now(),
            retryCount: this.config.maxRetries,
          });
          failedIds.add(nodeId);
          failureCount++;
          failedNodeInfos.push({
            nodeId,
            task: node.task,
            error,
            retryCount: this.config.maxRetries,
          });
          results.push({ nodeId, task: node.task, error });

          // LLM criticality evaluation
          if (opts?.criticalityEvaluator && hasDependents(nodeId)) {
            const failedNode = mutableNodes.get(nodeId)!;
            const parentTask = getParentTask(nodeId);
            const isCritical = await opts.criticalityEvaluator(failedNode, parentTask);
            if (!isCritical) {
              nonCriticalFailedIds.add(nodeId);
            }
          }
        }
      }
    };

    // Main execution loop: find ready nodes and execute in waves
    while (!aborted) {
      if (signal.aborted) {
        // Mark all pending as skipped
        for (const [id, node] of mutableNodes) {
          if (id === tree.rootId) continue;
          if (node.status === "pending") {
            updateNode(id, { status: "skipped" as const });
            skippedIds.add(id);
          }
        }
        aborted = true;
        break;
      }

      // Find ready nodes: pending + all deps satisfied
      const readyNodes: GoalNodeId[] = [];
      let hasPending = false;

      for (const [id, node] of mutableNodes) {
        if (id === tree.rootId) continue;
        if (node.status !== "pending") continue;
        hasPending = true;

        const allDepsSatisfied = node.dependsOn.every(
          (depId) =>
            completedIds.has(depId) ||
            depId === tree.rootId ||
            nonCriticalFailedIds.has(depId),
        );

        // Also check that deps are not in failedIds (critical) or skippedIds
        const anyDepBlocked = node.dependsOn.some(
          (depId) =>
            depId !== tree.rootId &&
            !completedIds.has(depId) &&
            !nonCriticalFailedIds.has(depId) &&
            (failedIds.has(depId) || skippedIds.has(depId)),
        );

        if (allDepsSatisfied && !anyDepBlocked) {
          readyNodes.push(id);
        }
      }

      // If no ready nodes but pending exist, they are dependency-blocked: mark as skipped
      if (readyNodes.length === 0) {
        if (hasPending) {
          for (const [id, node] of mutableNodes) {
            if (id === tree.rootId) continue;
            if (node.status === "pending") {
              updateNode(id, { status: "skipped" as const });
              skippedIds.add(id);
            }
          }
        }
        break;
      }

      // Execute wave
      if (this.config.parallelExecution) {
        // Parallel: run through semaphore with Promise.allSettled
        await Promise.allSettled(
          readyNodes.map((nodeId) =>
            semaphore.acquire(() => executeNode(nodeId)),
          ),
        );
      } else {
        // Sequential: run one at a time in order
        for (const nodeId of readyNodes) {
          await executeNode(nodeId);
        }
      }

      // Check failure budget after each wave
      if (failureCount >= this.config.maxFailures) {
        if (alwaysContinue) {
          // Skip callback, just continue
          continue;
        }

        if (opts?.onFailureBudgetExceeded) {
          const report: FailureReport = {
            tree: buildTree(),
            failedNodes: [...failedNodeInfos],
            failureCount,
            maxFailures: this.config.maxFailures,
          };
          const decision = await opts.onFailureBudgetExceeded(report);

          if (decision.alwaysContinue) {
            alwaysContinue = true;
          }
          if (!decision.continue) {
            // Abort: mark all remaining pending as skipped
            for (const [id, node] of mutableNodes) {
              if (id === tree.rootId) continue;
              if (node.status === "pending") {
                updateNode(id, { status: "skipped" as const });
                skippedIds.add(id);
              }
            }
            aborted = true;
            break;
          }
        } else {
          // No callback: abort
          for (const [id, node] of mutableNodes) {
            if (id === tree.rootId) continue;
            if (node.status === "pending") {
              updateNode(id, { status: "skipped" as const });
              skippedIds.add(id);
            }
          }
          aborted = true;
          break;
        }
      }
    }

    const finalTree = buildTree();
    const totalDurationMs = Date.now() - startTime;

    return {
      tree: finalTree,
      results,
      totalDurationMs,
      failureCount,
      aborted,
    };
  }
}
