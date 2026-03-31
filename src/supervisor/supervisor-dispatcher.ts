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
import {
  buildSupervisorCanvasNodeUpdate,
  buildSupervisorCanvasSummaryUpdate,
  buildSupervisorNodeNarrative,
  buildSupervisorWaveNarrative,
} from "./supervisor-feedback.js";

// =============================================================================
// TYPES
// =============================================================================

export interface DispatcherConfig {
  readonly maxParallelNodes: number;
  readonly nodeTimeoutMs: number;
  readonly maxFailureBudget: number;
}

export interface DispatcherOptions {
  readonly executeNode: (node: TaggedGoalNode, signal: AbortSignal) => Promise<NodeResult>;
  readonly config: DispatcherConfig;
  readonly eventEmitter?: { emit: (event: string, payload: unknown) => void };
  readonly rootId?: string;
  readonly taskDescription?: string;
  readonly displayTaskLabels?: ReadonlyMap<string, string>;
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

/** Tracks failure budget slots across running nodes. */
class FailureBudget {
  private consumed = 0;
  private inFlight = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly limit: number) {}

  exhausted(): boolean {
    return this.consumed >= this.limit;
  }

  async acquire(signal?: AbortSignal): Promise<boolean> {
    while (true) {
      if (this.exhausted()) {
        return false;
      }

      if ((this.consumed + this.inFlight) < this.limit) {
        this.inFlight++;
        return true;
      }

      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          if (signal) {
            signal.removeEventListener("abort", wake);
          }
          resolve();
        };

        this.waiters.add(wake);
        if (signal) {
          signal.addEventListener("abort", wake, { once: true });
        }
      });

      if (signal?.aborted) {
        return false;
      }
    }
  }

  succeed(): void {
    if (this.inFlight > 0) {
      this.inFlight--;
    }
    this.notify();
  }

  fail(): void {
    if (this.inFlight > 0) {
      this.inFlight--;
    }
    this.consumed++;
    this.notify();
  }

  private notify(): void {
    for (const wake of [...this.waiters]) {
      wake();
    }
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
  private readonly rootId?: string;
  private readonly taskDescription?: string;
  private readonly displayTaskLabels?: ReadonlyMap<string, string>;
  /** Node IDs that have been terminated (failed/aborted/skipped) — suppress stale events */
  private readonly terminatedNodes = new Set<string>();

  constructor(options: DispatcherOptions) {
    this.executeNode = options.executeNode;
    this.config = options.config;
    this.emitter = options.eventEmitter;
    this.rootId = options.rootId;
    this.taskDescription = options.taskDescription;
    this.displayTaskLabels = options.displayTaskLabels;
  }

  private getDisplayNode(node: TaggedGoalNode): TaggedGoalNode {
    const displayTask = this.displayTaskLabels?.get(String(node.id));
    if (!displayTask || displayTask === node.task) {
      return node;
    }
    return {
      ...node,
      task: displayTask,
    };
  }

  private emitActivity(detail: string, taskId?: string, action = "supervisor_dispatch"): void {
    this.emitter?.emit("monitor:agent_activity", {
      ...(taskId ? { taskId } : {}),
      action,
      detail,
      timestamp: Date.now(),
    });
  }

  private emitNodeWorkspaceStatus(
    node: TaggedGoalNode,
    status: "executing" | "completed" | "failed" | "skipped" | "verifying",
    result?: Pick<NodeResult, "duration">,
    error?: string,
  ): void {
    if (!this.rootId) {
      return;
    }
    // Suppress stale events from nodes that have already terminated
    const nodeId = String(node.id);
    if (this.terminatedNodes.has(nodeId) && status === "executing") {
      return;
    }
    // Track terminal states so background-running promises can't re-emit
    if (status === "failed" || status === "completed" || status === "skipped") {
      this.terminatedNodes.add(nodeId);
    }

    this.emitter?.emit("monitor:task_update", {
      rootId: this.rootId,
      nodeId: String(node.id),
      status,
      agentId: node.assignedProvider ?? "unknown",
      phase: status === "executing" ? "acting" : "observing",
      ...(status === "executing" ? { startedAt: Date.now() } : {}),
      ...(status !== "executing" ? { completedAt: Date.now() } : {}),
      ...(result?.duration ? { elapsed: result.duration } : {}),
      ...(error ? { error } : {}),
    });
  }

  private emitNodeNarrative(
    node: TaggedGoalNode,
    status: "pending" | "running" | "verifying" | "done" | "failed" | "skipped",
    reason?: string,
  ): void {
    // Suppress stale narratives from nodes that already terminated
    if (this.terminatedNodes.has(String(node.id)) && status === "running") {
      return;
    }
    const taskDescription = this.taskDescription;
    if (!taskDescription) {
      return;
    }
    const feedback = buildSupervisorNodeNarrative({
      task: taskDescription,
      node: this.getDisplayNode(node),
      status,
      ...(reason ? { reason } : {}),
    });
    this.emitter?.emit("progress:narrative", {
      nodeId: String(node.id),
      narrative: feedback.narrative,
      lang: feedback.language,
    });
  }

  private emitNodeCanvasUpdate(
    node: TaggedGoalNode,
    status: "pending" | "running" | "verifying" | "done" | "failed" | "skipped",
  ): void {
    this.emitter?.emit("canvas:agent_draw", buildSupervisorCanvasNodeUpdate({
      node: this.getDisplayNode(node),
      status,
    }));
  }

  private emitSkippedNode(node: TaggedGoalNode, reason: string): NodeResult {
    const result = this.makeSkippedResult(node, reason);
    this.emitNodeWorkspaceStatus(node, "skipped", result);
    this.emitNodeNarrative(node, "skipped", reason);
    this.emitNodeCanvasUpdate(node, "skipped");
    this.emitActivity(reason, String(node.id), "supervisor_node_skipped");
    this.emitter?.emit("supervisor:node_complete", {
      nodeId: node.id,
      status: result.status,
      duration: result.duration ?? 0,
      cost: result.cost ?? 0,
    });
    return result;
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
    let failureCount = 0;
    let budgetExhausted = false;

    const concurrency = new Semaphore(this.config.maxParallelNodes);
    const budget = new FailureBudget(this.config.maxFailureBudget);

    for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
      const wave = waves[waveIndex]!;
      if (budgetExhausted || signal?.aborted) break;

      this.emitter?.emit("supervisor:wave_start", {
        waveIndex,
        nodes: wave.map((n) => ({ nodeId: n.id, provider: n.assignedProvider ?? "unknown" })),
      });
      if (this.rootId && this.taskDescription) {
        const displayNodes = wave.map((node) => this.getDisplayNode(node));
        const feedback = buildSupervisorWaveNarrative({
          task: this.taskDescription,
          waveIndex,
          totalWaves: waves.length,
          nodes: displayNodes,
        });
        this.emitter?.emit("progress:narrative", {
          narrative: feedback.narrative,
          lang: feedback.language,
        });
        this.emitter?.emit("canvas:agent_draw", buildSupervisorCanvasSummaryUpdate({
          rootId: this.rootId,
          summary: feedback.canvasSummary,
          tone: "active",
        }));
        this.emitActivity(feedback.narrative, undefined, "supervisor_wave_start");
      }

      const inFlight: Promise<void>[] = [];
      const waveResults: NodeResult[] = [];

      for (const node of wave) {
        // Check if any dependency failed -> skip
        const hasFailedDep = node.dependsOn.some((depId) =>
          failedNodeIds.has(depId as string),
        );
        if (hasFailedDep) {
          results.push(this.emitSkippedNode(node, "Skipped: dependency failed"));
          continue;
        }

        if (budgetExhausted || signal?.aborted) {
          results.push(this.emitSkippedNode(node, "Skipped: budget exhausted or aborted"));
          continue;
        }

        const reservedBudget = await budget.acquire(signal);
        if (!reservedBudget) {
          budgetExhausted = true;
          results.push(this.emitSkippedNode(node, "Skipped: budget exhausted"));
          continue;
        }

        await concurrency.acquire();

        if (budgetExhausted || signal?.aborted || budget.exhausted()) {
          concurrency.release();
          budget.succeed();
          results.push(this.emitSkippedNode(node, "Skipped: budget exhausted or aborted"));
          continue;
        }

        const task = (async () => {
          try {
            const result = await this.executeWithRetry(node, signal, waveIndex);
            results.push(result);

            if (result.status === "failed") {
              failedNodeIds.add(node.id as string);
              failureCount++;
              budget.fail();
              if (failureCount >= this.config.maxFailureBudget) {
                budgetExhausted = true;
              }
              this.emitNodeWorkspaceStatus(node, "failed", result, result.output || "Unknown error");
              this.emitNodeNarrative(node, "failed", result.output);
              this.emitNodeCanvasUpdate(node, "failed");
              this.emitActivity(result.output ?? "Unknown error", String(node.id), "supervisor_node_failed");
              this.emitter?.emit("supervisor:node_failed", {
                nodeId: node.id,
                error: result.output ?? "Unknown error",
                failureLevel: 1,
                nextAction: "skip",
              });
            } else {
              budget.succeed();
              const workspaceStatus = result.status === "ok" ? "completed" : "skipped";
              const narrativeStatus = result.status === "ok" ? "done" : "skipped";
              this.emitNodeWorkspaceStatus(
                node,
                workspaceStatus,
                result,
                result.status === "skipped" ? result.output : undefined,
              );
              this.emitNodeNarrative(node, narrativeStatus);
              this.emitNodeCanvasUpdate(node, narrativeStatus);
              this.emitActivity(
                result.status === "ok" ? "Node completed" : "Node skipped",
                String(node.id),
                "supervisor_node_complete",
              );
              this.emitter?.emit("supervisor:node_complete", {
                nodeId: node.id,
                status: result.status,
                duration: result.duration ?? 0,
                cost: result.cost ?? 0,
              });
            }
            waveResults.push(result);
          } finally {
            concurrency.release();
          }
        })();

        inFlight.push(task);
      }

      await Promise.allSettled(inFlight);

      this.emitter?.emit("supervisor:wave_done", {
        waveIndex,
        results: waveResults.map((r) => ({ nodeId: r.nodeId, status: r.status })),
        totalCost: waveResults.reduce((sum, r) => sum + (r.cost ?? 0), 0),
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  /** Factory for NodeResult objects — eliminates repeated boilerplate */
  private makeResult(
    node: TaggedGoalNode,
    status: NodeResult["status"],
    output: string,
    overrides?: Partial<Pick<NodeResult, "cost" | "duration">>,
  ): NodeResult {
    return {
      nodeId: node.id,
      status,
      output,
      artifacts: [],
      toolResults: [],
      provider: node.assignedProvider ?? "unknown",
      model: node.assignedModel ?? "unknown",
      cost: overrides?.cost ?? 0,
      duration: overrides?.duration ?? 0,
    };
  }

  private makeSkippedResult(node: TaggedGoalNode, reason: string): NodeResult {
    return this.makeResult(node, "skipped", reason);
  }

  // ---------------------------------------------------------------------------
  // EXECUTE WITH RETRY + TIMEOUT
  // ---------------------------------------------------------------------------

  private async executeWithRetry(
    node: TaggedGoalNode,
    externalSignal?: AbortSignal,
    waveIndex = 0,
  ): Promise<NodeResult> {
    const maxAttempts = 2; // 1 initial + 1 retry

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.emitter?.emit("supervisor:node_start", {
          nodeId: node.id,
          provider: node.assignedProvider ?? "unknown",
          model: node.assignedModel ?? "unknown",
          wave: waveIndex,
        });
        this.emitNodeWorkspaceStatus(node, "executing");
        this.emitNodeNarrative(node, "running");
        this.emitNodeCanvasUpdate(node, "running");
        this.emitActivity(
          `Started on ${node.assignedProvider ?? "unknown"}`,
          String(node.id),
          "supervisor_node_start",
        );

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
        return this.makeResult(
          node,
          "failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Should not reach here, but safety fallback
    return this.makeResult(node, "failed", "Max retry attempts exhausted");
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
      const nodePromise = this.executeNode(node, nodeController.signal);
      // Suppress eventual rejection from the losing leg of the race
      // to prevent unhandled-rejection crashes when abort wins.
      nodePromise.catch(() => {});
      const result = await Promise.race([
        nodePromise,
        this.waitForAbort(nodeController.signal),
      ]);
      return result;
    } catch (err) {
      // Abort the node controller so in-flight fetch() calls are cancelled
      nodeController.abort();
      throw err;
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
