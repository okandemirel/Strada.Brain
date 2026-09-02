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
import { getLoggerSafe } from "../utils/logger.js";
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
  /** Conversation/chat scope for per-conversation root grouping in the monitor (optional). */
  readonly conversationId?: string;
  readonly taskDescription?: string;
  readonly displayTaskLabels?: ReadonlyMap<string, string>;
  /**
   * Called on every node status change, purely as a liveness signal.
   *
   * The per-task inactivity watchdog is re-armed by progress updates, and the
   * supervisor path only emits those at planning milestones — activation, goal
   * decomposition, status summaries. Between them a wave can run tools for
   * twenty minutes without producing one, and the watchdog then stops a task
   * that is working and tells the user it made no progress. Measured exactly
   * that: "Task made no progress for 1200000ms" fired four seconds after a tool
   * call and two LLM calls.
   */
  readonly onLiveness?: () => void;
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

/**
 * Counts failures against the configured budget.
 *
 * audited 2026-09-02: this used to reserve a permit per IN-FLIGHT node and make
 * the dispatch loop wait for one to come back, so a wave could never run wider
 * than `maxFailureBudget` (3 by default) — a silent second semaphore that capped
 * the account-scaled `maxParallelNodes` at 3 and named nothing. The design spec
 * defines the budget as "stop after N failures, abort the rest", so it now gates
 * on failures actually consumed: nodes already in flight when the budget is
 * spent still finish (overshoot bounded by the wave width), and nothing new
 * launches after it.
 */
class FailureBudget {
  private consumed = 0;

  constructor(private readonly limit: number) {}

  exhausted(): boolean {
    return this.consumed >= this.limit;
  }

  /** True when a node may launch: the budget is not yet spent. Never waits. */
  acquire(): boolean {
    return !this.exhausted();
  }

  fail(): void {
    this.consumed++;
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

/**
 * The dispatcher's own per-node timeout. Distinguished by type, not by text:
 * its message contains "timeout", which TRANSIENT_PATTERNS matches, and
 * attempt 0 used to sleep 2s and run the whole node AGAIN — a stuck node burned
 * two full windows (6h + 6h at the shipped defaults) before it was reported
 * failed, with the abandoned first run still executing (audited 2026-09-02).
 * The window is already the whole budget; a second one measures nothing new.
 */
class NodeTimeoutError extends Error {
  readonly perNodeTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = "NodeTimeoutError";
  }
}

// =============================================================================
// DISPATCHER
// =============================================================================

export class SupervisorDispatcher {
  private readonly executeNode: DispatcherOptions["executeNode"];
  private readonly config: DispatcherConfig;
  private readonly emitter?: DispatcherOptions["eventEmitter"];
  private readonly onLiveness?: DispatcherOptions["onLiveness"];
  private readonly rootId?: string;
  private readonly conversationId?: string;
  private readonly taskDescription?: string;
  private readonly displayTaskLabels?: ReadonlyMap<string, string>;
  /** Node IDs that have reached a terminal state (failed/completed/skipped) — suppress stale events from background-running promises */
  private readonly terminatedNodes = new Set<string>();

  constructor(options: DispatcherOptions) {
    this.executeNode = options.executeNode;
    this.config = options.config;
    this.emitter = options.eventEmitter;
    this.onLiveness = options.onLiveness;
    this.rootId = options.rootId;
    this.conversationId = options.conversationId;
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
    // Before the rootId guard: liveness is about the task being alive, not about
    // anything watching it. rootId is only set when the monitor is attached, so
    // gating on it would leave the headless background path — the one the
    // watchdog actually kills — with no signal at all.
    this.onLiveness?.();
    if (!this.rootId) {
      return;
    }
    const nodeId = String(node.id);

    // Suppress stale events from nodes that have already terminated
    if (this.terminatedNodes.has(nodeId) && status === "executing") {
      return;
    }
    // Track terminal states so background-running promises can't re-emit
    if (status === "failed" || status === "completed" || status === "skipped") {
      this.terminatedNodes.add(nodeId);
    }

    this.emitter?.emit("monitor:task_update", {
      rootId: this.rootId,
      nodeId,
      status,
      agentId: node.assignedProvider ?? "unknown",
      phase: status === "executing" ? "acting" : "observing",
      ...(status === "executing" ? { startedAt: Date.now() } : {}),
      ...(status !== "executing" ? { completedAt: Date.now() } : {}),
      ...(result?.duration ? { elapsed: result.duration } : {}),
      ...(error ? { error } : {}),
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
    });
  }

  private emitNodeNarrative(
    node: TaggedGoalNode,
    status: "pending" | "running" | "verifying" | "done" | "failed" | "skipped",
    reason?: string,
  ): void {
    // Suppress stale narratives from nodes that already terminated
    if (this.terminatedNodes.has(String(node.id)) && (status === "running" || status === "verifying")) {
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
    const nodeId = String(node.id);
    if (this.terminatedNodes.has(nodeId) && (status === "running" || status === "verifying")) {
      return;
    }
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

  /**
   * Emit a node terminated by a control-plane abort (sibling winddown / task cancel).
   * Twin of {@link emitSkippedNode} but reports the first-class "cancelled" status so
   * the ResultAggregator excludes it from the failure gate (audit #13). It surfaces
   * through the benign "skipped" UI path — a control-plane cancel is NOT an error, so
   * it must not flow through the node_failed path that produces "All providers failed"
   * log-noise.
   */
  private emitCancelledNode(node: TaggedGoalNode, reason: string): NodeResult {
    const result = this.makeCancelledResult(node, reason);
    this.emitNodeWorkspaceStatus(node, "skipped", result);
    this.emitNodeNarrative(node, "skipped", reason);
    this.emitNodeCanvasUpdate(node, "skipped");
    this.emitActivity(reason, String(node.id), "supervisor_node_cancelled");
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

      // Safety: no progress means the remaining nodes form a dependency cycle
      // (or depend on one). Stop scheduling — but the caller MUST be told which
      // nodes were left out; see `findUnschedulableNodes`.
      if (wave.length === 0) break;

      for (const node of wave) {
        assigned.add(node.id as string);
      }
      waves.push(wave);
    }

    return waves;
  }

  /**
   * Nodes that `computeWaves` could not schedule — i.e. those in a dependency
   * cycle, or depending on one.
   *
   * These used to vanish: `computeWaves` dropped them and `dispatch` returned
   * results only for what it ran, so a goal whose LLM-authored plan contained a
   * cycle reported every node it *did* run as successful and the caller saw a
   * clean completion. The user was told work was finished that was never even
   * scheduled. Surfacing them as failed results makes the existing
   * success/failure aggregation report the truth.
   */
  findUnschedulableNodes(
    nodes: TaggedGoalNode[],
    waves: TaggedGoalNode[][],
  ): TaggedGoalNode[] {
    const scheduled = new Set<string>();
    for (const wave of waves) {
      for (const node of wave) scheduled.add(node.id as string);
    }
    return nodes.filter((n) => !scheduled.has(n.id as string));
  }

  // ---------------------------------------------------------------------------
  // DISPATCH
  // ---------------------------------------------------------------------------

  /**
   * Execute all nodes in wave order. Nodes within a wave run in parallel
   * up to maxParallelNodes concurrency. Returns collected NodeResults.
   *
   * Concurrency is bounded by `maxParallelNodes` alone. The failure budget is a
   * counter of failures, checked before every launch: once `maxFailureBudget`
   * failures have been recorded, remaining nodes are skipped instead of run.
   */
  async dispatch(
    nodes: TaggedGoalNode[],
    signal?: AbortSignal,
  ): Promise<NodeResult[]> {
    const waves = this.computeWaves(nodes);
    const results: NodeResult[] = [];

    // Nodes stuck in a dependency cycle are never scheduled. Record them as
    // FAILED up front so they cannot be mistaken for work that succeeded.
    // audited 2026-09-02: the reason used to ride in `blockedReason`, which the
    // aggregator files under "blocked" — documented as "stopped on a question".
    // A cycle is a planning defect: an all-cycle plan came back partial:true
    // with zero successes and was replayed as if an answer were pending. The
    // reason now lives in `output`, so it aggregates as the failure it is.
    const unschedulable = this.findUnschedulableNodes(nodes, waves);
    for (const node of unschedulable) {
      const reason =
        "dependency cycle: this node's dependencies can never all resolve, so it was never scheduled";
      results.push({
        nodeId: node.id,
        status: "failed",
        output: reason,
        artifacts: [],
        toolResults: [],
        provider: node.assignedProvider ?? "unassigned",
        model: "",
        cost: 0,
        duration: 0,
      });
      this.emitNodeNarrative(node, "failed", reason);
    }
    if (unschedulable.length > 0) {
      getLoggerSafe().warn("Supervisor: goal contains a dependency cycle", {
        unschedulableNodeIds: unschedulable.map((n) => n.id),
        scheduled: nodes.length - unschedulable.length,
        total: nodes.length,
      });
    }
    const failedNodeIds = new Set<string>();
    // A skipped node leaves its dependents unsatisfied just like a failed one,
    // so track skips too and propagate them transitively (a dependent of a
    // skipped node must also skip — otherwise it runs with a missing dependency).
    const skippedNodeIds = new Set<string>();
    let failureCount = 0;
    let budgetExhausted = false;

    const concurrency = new Semaphore(this.config.maxParallelNodes);
    const budget = new FailureBudget(this.config.maxFailureBudget);

    for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
      const wave = waves[waveIndex]!;
      if (signal?.aborted) break;
      if (budgetExhausted) {
        // audited 2026-09-02: this used to `break`, so every node in a later
        // wave produced no NodeResult and no event; the aggregator's
        // totalNodes (= results.length) shrank to match and a 10-node plan
        // settled as "3 nodes, all failed" with seven planned sub-goals
        // unmentioned. Drain the wave as skipped results instead — no
        // wave_start, nothing launched, every node accounted for.
        for (const node of wave) {
          skippedNodeIds.add(node.id as string);
          const dependencyFailed = node.dependsOn.some((depId) => failedNodeIds.has(depId as string));
          results.push(this.emitSkippedNode(
            node,
            dependencyFailed ? "Skipped: dependency failed" : "Skipped: budget exhausted",
          ));
        }
        continue;
      }

      this.emitter?.emit("supervisor:wave_start", {
        waveIndex,
        nodes: wave.map((n) => ({ nodeId: n.id, provider: n.assignedProvider ?? "unknown" })),
      });
      if (signal?.aborted) break;
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
        const hasUnsatisfiedDep = node.dependsOn.some((depId) =>
          failedNodeIds.has(depId as string) || skippedNodeIds.has(depId as string),
        );
        if (hasUnsatisfiedDep) {
          skippedNodeIds.add(node.id as string);
          results.push(this.emitSkippedNode(node, "Skipped: dependency failed"));
          continue;
        }

        if (budgetExhausted || signal?.aborted) {
          // A control-plane abort is a benign cancel, not a skip: emit "cancelled"
          // (excluded from the failure gate). Only a budget-exhausted node is skipped,
          // and a skip leaves dependents unsatisfied so it must propagate transitively.
          if (signal?.aborted) {
            results.push(this.emitCancelledNode(node, "Cancelled: control-plane abort"));
          } else {
            skippedNodeIds.add(node.id as string);
            results.push(this.emitSkippedNode(node, "Skipped: budget exhausted"));
          }
          continue;
        }

        if (!budget.acquire()) {
          budgetExhausted = true;
          skippedNodeIds.add(node.id as string);
          results.push(this.emitSkippedNode(node, "Skipped: budget exhausted"));
          continue;
        }

        await concurrency.acquire();

        if (budgetExhausted || signal?.aborted || budget.exhausted()) {
          concurrency.release();
          // Same split as the pre-budget guard: a control-plane abort cancels (benign,
          // excluded from the failure gate); budget exhaustion skips (and propagates).
          if (signal?.aborted) {
            results.push(this.emitCancelledNode(node, "Cancelled: control-plane abort"));
          } else {
            skippedNodeIds.add(node.id as string);
            results.push(this.emitSkippedNode(node, "Skipped: budget exhausted"));
          }
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

  private makeCancelledResult(node: TaggedGoalNode, reason: string): NodeResult {
    return this.makeResult(node, "cancelled", reason);
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
        if (attempt === 0) {
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
        }

        const result = await this.executeWithTimeout(node, externalSignal);
        return result;
      } catch (err: unknown) {
        // Control-plane cancellation: the external (dispatch) signal aborted this node
        // in-flight (sibling winddown / task cancel). That is a benign cancel, NOT a
        // failure — return a first-class "cancelled" result so it is excluded from the
        // failure gate and skips the node_failed error-noise (audit #13). Checked before
        // the transient-retry branch so a real cancel never burns a retry. A per-node
        // *timeout* (externalSignal NOT aborted) still falls through to "failed".
        if (externalSignal?.aborted) {
          return this.makeCancelledResult(node, "Cancelled: control-plane abort");
        }

        // On first attempt, retry if transient — but never into a fully
        // cooling chain: the chain's terminal error carries "rate limit"/
        // "429" fragments that read as transient, and a wave multiplies the
        // doomed extra call across every node (measured 2026-08-29). A
        // per-node timeout is never transient (audited 2026-09-02).
        if (attempt === 0 && !(err instanceof NodeTimeoutError) && isTransientError(err)) {
          const { allProvidersCoolingDownMs } = await import("../agents/providers/provider-outage.js");
          if (allProvidersCoolingDownMs() > 0) {
            return this.makeResult(
              node,
              "failed",
              `All providers are in cooldown: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
            );
          }
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
    const startedAt = Date.now();
    const timeoutMs = this.config.nodeTimeoutMs;
    const nodeLabel = node.task?.slice(0, 80) ?? node.id ?? "unknown-node";

    // Link external signal to node controller
    const onExternalAbort = (): void => nodeController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw new Error(
          `Aborted before execution (node="${nodeLabel}", externally signalled)`,
        );
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // Explicit timeout promise: rejects with context-rich error (no silent suppression)
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        nodeController.abort();
        const elapsed = Date.now() - startedAt;
        reject(
          new Error(
            `Tool timeout after ${timeoutMs}ms (node="${nodeLabel}", elapsed=${elapsed}ms, reason=per-node-timeout)`,
          ),
        );
      }, timeoutMs);
    });

    // Abort-reject leg: fires when the node controller is aborted — either
    // externally (user cancel) or internally (timeout above). Needed because
    // executeNode may not honour its signal immediately; this ensures
    // Promise.race resolves as soon as the abort is observed.
    const abortPromise = new Promise<never>((_, reject) => {
      const sig = nodeController.signal;
      if (sig.aborted) {
        reject(new Error(`Aborted (node="${nodeLabel}")`));
        return;
      }
      sig.addEventListener(
        "abort",
        () => reject(new Error(`Aborted (node="${nodeLabel}")`)),
        { once: true },
      );
    });

    // Defuse the losing legs' rejections so they never bubble up as
    // unhandled rejections. The winner's error is still surfaced via
    // Promise.race below.
    const nodePromise = this.executeNode(node, nodeController.signal);
    nodePromise.catch(() => { /* swallowed for race-loser only */ });
    abortPromise.catch(() => { /* swallowed for race-loser only */ });

    try {
      const result = await Promise.race([nodePromise, timeoutPromise, abortPromise]);
      return result;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      // audited 2026-09-02: the controller was aborted BEFORE the reason was
      // classified, so `signal.aborted` was always true, every error read as
      // "timeout-or-node-abort" (which contains "timeout") and was retried as
      // transient — a plain compile error included. Classify first, then abort.
      // The timer aborts the controller before its own rejection lands, so the
      // abort leg wins the race on a timeout; `timedOut` names the real cause.
      const abortedBeforeCatch = nodeController.signal.aborted;
      const reason = timedOut
        ? "per-node-timeout"
        : externalSignal?.aborted
          ? "external-abort"
          : abortedBeforeCatch
            ? "node-abort"
            : "node-error";
      const baseMsg = timedOut
        ? `Tool timeout after ${timeoutMs}ms`
        : (err instanceof Error ? err.message : String(err));
      // Abort the node controller so in-flight fetch() calls are cancelled
      nodeController.abort();
      const message = `${baseMsg} [node="${nodeLabel}", elapsed=${elapsed}ms, reason=${reason}]`;
      throw timedOut ? new NodeTimeoutError(message) : new Error(message);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
