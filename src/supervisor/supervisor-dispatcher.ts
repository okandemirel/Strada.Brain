/**
 * SupervisorDispatcher — Wave-based parallel execution of assigned goal nodes.
 *
 * Computes dependency waves via topological sort, then dispatches each wave
 * sequentially with intra-wave parallelism controlled by a semaphore.
 *
 * Features:
 * - Topological wave computation (computeWaves)
 * - Semaphore-bounded parallel execution within waves
 * - Per-node timeout via AbortController
 * - External cancellation via AbortSignal
 * - L1 retry (one retry with 2s backoff on transient errors)
 * - Failure budget (abort remaining after N failures)
 * - Dependency-aware skipping (skip nodes whose deps failed)
 */

import type { TaggedGoalNode, NodeResult } from "./supervisor-types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface DispatcherConfig {
  readonly maxParallelNodes: number;
  readonly nodeTimeoutMs: number;
  readonly maxFailureBudget: number;
}

export interface DispatcherOptions {
  readonly executeNode: (node: TaggedGoalNode) => Promise<NodeResult>;
  readonly config: DispatcherConfig;
  readonly eventEmitter?: { emit: (event: string, payload: unknown) => void };
}

// =============================================================================
// SEMAPHORE
// =============================================================================

/** Simple queue-based semaphore for concurrency control */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  /** Non-blocking acquire: returns true if a slot was available, false otherwise */
  tryAcquire(): boolean {
    if (this.running < this.max) {
      this.running++;
      return true;
    }
    return false;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// =============================================================================
// TRANSIENT ERROR DETECTION
// =============================================================================

const TRANSIENT_PATTERNS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "socket hang up",
  "network",
  "timeout",
  "rate limit",
  "429",
  "503",
  "502",
];

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

// =============================================================================
// DISPATCHER
// =============================================================================

export class SupervisorDispatcher {
  private readonly executeNode: DispatcherOptions["executeNode"];
  private readonly config: DispatcherConfig;
  private readonly emitter?: DispatcherOptions["eventEmitter"];

  constructor(options: DispatcherOptions) {
    this.executeNode = options.executeNode;
    this.config = options.config;
    this.emitter = options.eventEmitter;
  }

  // ---------------------------------------------------------------------------
  // WAVE COMPUTATION
  // ---------------------------------------------------------------------------

  /**
   * Topological sort of nodes into dependency waves.
   * Wave 0 = nodes with no unresolved dependencies.
   * Wave N = nodes whose dependencies all resolve by wave N-1.
   */
  computeWaves(nodes: TaggedGoalNode[]): TaggedGoalNode[][] {
    const nodeMap = new Map<string, TaggedGoalNode>();
    for (const node of nodes) {
      nodeMap.set(node.id as string, node);
    }

    const nodeIds = new Set(nodes.map((n) => n.id as string));
    const assigned = new Set<string>();
    const waves: TaggedGoalNode[][] = [];

    // Iterate until all nodes are assigned to a wave
    while (assigned.size < nodes.length) {
      const wave: TaggedGoalNode[] = [];

      for (const node of nodes) {
        const id = node.id as string;
        if (assigned.has(id)) continue;

        // Check if all dependencies within this node set are resolved
        const depsResolved = node.dependsOn.every((depId) => {
          const dep = depId as string;
          // If dep is not in our node set, treat as resolved (external)
          if (!nodeIds.has(dep)) return true;
          return assigned.has(dep);
        });

        if (depsResolved) {
          wave.push(node);
        }
      }

      // Safety: if no progress, break to avoid infinite loop (cycle in DAG)
      if (wave.length === 0) break;

      for (const node of wave) {
        assigned.add(node.id as string);
      }
      waves.push(wave);
    }

    return waves;
  }

  // ---------------------------------------------------------------------------
  // DISPATCH
  // ---------------------------------------------------------------------------

  /**
   * Execute all nodes in wave order. Nodes within a wave run in parallel
   * up to maxParallelNodes concurrency. Returns collected NodeResults.
   *
   * Uses a budget-semaphore pattern: a secondary semaphore tracks available
   * failure budget. Each launched node acquires a "budget permit". On success,
   * the permit is returned. On failure, it is consumed. Once all budget permits
   * are gone, remaining nodes cannot launch and are skipped.
   */
  async dispatch(
    nodes: TaggedGoalNode[],
    signal?: AbortSignal,
  ): Promise<NodeResult[]> {
    const waves = this.computeWaves(nodes);
    const results: NodeResult[] = [];
    const failedNodeIds = new Set<string>();
    let budgetExhausted = false;

    const concurrency = new Semaphore(this.config.maxParallelNodes);
    // Budget semaphore: starts with maxFailureBudget permits.
    // Each in-flight node holds one. Returned on success, consumed on failure.
    const budget = new Semaphore(this.config.maxFailureBudget);

    for (const wave of waves) {
      if (budgetExhausted || signal?.aborted) break;

      const inFlight: Promise<void>[] = [];

      for (const node of wave) {
        // Check if any dependency failed -> skip
        const hasFailedDep = node.dependsOn.some((depId) =>
          failedNodeIds.has(depId as string),
        );
        if (hasFailedDep) {
          results.push(this.makeSkippedResult(node, "Skipped: dependency failed"));
          continue;
        }

        if (budgetExhausted || signal?.aborted) {
          results.push(this.makeSkippedResult(node, "Skipped: budget exhausted or aborted"));
          continue;
        }

        // Acquire both concurrency slot and budget permit before launching.
        // Budget permit is acquired first (non-blocking check via tryAcquire).
        // If no budget permits remain, skip this and all subsequent nodes.
        const gotBudget = budget.tryAcquire();
        if (!gotBudget) {
          budgetExhausted = true;
          results.push(this.makeSkippedResult(node, "Skipped: budget exhausted"));
          continue;
        }

        await concurrency.acquire();

        if (budgetExhausted || signal?.aborted) {
          concurrency.release();
          budget.release(); // return unused permit
          results.push(this.makeSkippedResult(node, "Skipped: budget exhausted or aborted"));
          continue;
        }

        const task = (async () => {
          try {
            const result = await this.executeWithRetry(node, signal);
            results.push(result);

            if (result.status === "failed") {
              failedNodeIds.add(node.id as string);
              // Budget permit is consumed (not returned)
              this.emitter?.emit("supervisor:node:fail", {
                nodeId: node.id,
                provider: result.provider,
              });
            } else {
              // Success: return the budget permit
              budget.release();
              this.emitter?.emit("supervisor:node:complete", {
                nodeId: node.id,
                provider: result.provider,
              });
            }
          } finally {
            concurrency.release();
          }
        })();

        inFlight.push(task);
      }

      await Promise.allSettled(inFlight);
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private makeSkippedResult(node: TaggedGoalNode, reason: string): NodeResult {
    return {
      nodeId: node.id,
      status: "skipped",
      output: reason,
      artifacts: [],
      toolResults: [],
      provider: node.assignedProvider ?? "unknown",
      model: node.assignedModel ?? "unknown",
      cost: 0,
      duration: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // EXECUTE WITH RETRY + TIMEOUT
  // ---------------------------------------------------------------------------

  private async executeWithRetry(
    node: TaggedGoalNode,
    externalSignal?: AbortSignal,
  ): Promise<NodeResult> {
    const maxAttempts = 2; // 1 initial + 1 retry

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.emitter?.emit("supervisor:node:start", {
          nodeId: node.id,
          provider: node.assignedProvider,
          attempt,
        });

        const result = await this.executeWithTimeout(node, externalSignal);
        return result;
      } catch (err: unknown) {
        // On first attempt, retry if transient
        if (attempt === 0 && isTransientError(err)) {
          // 2s backoff before retry
          await this.delay(2000);
          continue;
        }

        // Non-transient or second attempt: fail
        return {
          nodeId: node.id,
          status: "failed",
          output: err instanceof Error ? err.message : String(err),
          artifacts: [],
          toolResults: [],
          provider: node.assignedProvider ?? "unknown",
          model: node.assignedModel ?? "unknown",
          cost: 0,
          duration: 0,
        };
      }
    }

    // Should not reach here, but safety fallback
    return {
      nodeId: node.id,
      status: "failed",
      output: "Max retry attempts exhausted",
      artifacts: [],
      toolResults: [],
      provider: node.assignedProvider ?? "unknown",
      model: node.assignedModel ?? "unknown",
      cost: 0,
      duration: 0,
    };
  }

  private async executeWithTimeout(
    node: TaggedGoalNode,
    externalSignal?: AbortSignal,
  ): Promise<NodeResult> {
    const nodeController = new AbortController();

    // Link external signal to node controller
    const onExternalAbort = (): void => nodeController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw new Error("Aborted");
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // Set per-node timeout
    const timer = setTimeout(
      () => nodeController.abort(),
      this.config.nodeTimeoutMs,
    );

    try {
      const result = await Promise.race([
        this.executeNode(node),
        this.waitForAbort(nodeController.signal),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * Returns a promise that rejects when the signal is aborted.
   * Used in Promise.race to implement timeout/cancellation.
   */
  private waitForAbort(signal: AbortSignal): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("Aborted")),
        { once: true },
      );
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
