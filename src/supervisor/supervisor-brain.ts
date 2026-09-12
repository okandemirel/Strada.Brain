/**
 * SupervisorBrain — Pipeline orchestrator for multi-provider task decomposition.
 *
 * Ties together the full supervisor pipeline:
 *   GoalDecomposer → CapabilityMatcher → ProviderAssigner → SupervisorDispatcher → ResultAggregator
 *
 * Handles abort signals, emits telemetry events, and returns partial results
 * when the pipeline is interrupted mid-execution.
 */

import type { GoalNode, GoalNodeId, GoalStatus, GoalTree } from "../goals/types.js";
import { withLivenessHeartbeat } from "../agents/liveness-hub.js";
import { getLoggerSafe } from "../utils/logger.js";
import type {
  NodeResult,
  SupervisorConfig,
  SupervisorContext,
  SupervisorResult,
  TaggedGoalNode,
  VerificationVerdict,
} from "./supervisor-types.js";
import { canonicalizeProviderName } from "../agents/providers/provider-identity.js";
import { resolveConversationScope } from "../agents/orchestrator-text-utils.js";
import type { CapabilityMatcher } from "./capability-matcher.js";
import type { ProviderAssigner } from "./provider-assigner.js";
import { SupervisorDispatcher } from "./supervisor-dispatcher.js";
import { ResultAggregator } from "./result-aggregator.js";
import { goalTreeToDagPayload } from "../dashboard/workspace-events.js";
import {
  buildSupervisorAbortNarrative,
  buildSupervisorActivationNarrative,
  buildSupervisorCanvasPlan,
  buildSupervisorCanvasSummaryUpdate,
  buildSupervisorCompletionNarrative,
  buildSupervisorPlanNarrative,
  buildSupervisorVerificationNarrative,
} from "./supervisor-feedback.js";

// =============================================================================
// DECOMPOSER INTERFACE (minimal contract for loose coupling)
// =============================================================================

/** Minimal interface for the GoalDecomposer dependency */
export interface SupervisorDecomposer {
  shouldDecompose(prompt: string): boolean;
  decomposeProactive(sessionId: string, taskDescription: string): Promise<GoalTree>;
}

// =============================================================================
// OPTIONS
// =============================================================================

export interface SupervisorBrainOptions {
  readonly config: SupervisorConfig;
  readonly decomposer: SupervisorDecomposer;
  readonly capabilityMatcher: CapabilityMatcher;
  readonly providerAssigner: ProviderAssigner;
  readonly eventEmitter?: { emit: (event: string, payload: unknown) => void };
  readonly verifyNode?: (node: NodeResult, context: SupervisorContext) => Promise<VerificationVerdict>;
  /**
   * Where a node's status lives. The resume re-verification writes a rejected
   * step back as `failed` so a retry RE-RUNS it instead of re-verifying the
   * same saved output forever (Codex 2026-09-11 C#5).
   */
  readonly goalStorage?: { updateNodeStatus(nodeId: GoalNodeId, status: GoalStatus, result?: string, error?: string, retryCount?: number, redecompositionCount?: number, reviewStatus?: string, reviewIterations?: number): void };
}

// =============================================================================
// SUPERVISOR BRAIN
// =============================================================================

/**
 * How many nodes of one wave may run at once.
 *
 * A SHARED task lease means one worktree: concurrent nodes would write the
 * same files with no lock and no usable conflict recovery, so they serialize.
 * When the executor grants per-node workspaces (each node a real worktree off
 * the project root, commits lock-covered — see the execute-node bridge) the
 * configured width applies again. No lease at all: nodes already take their
 * own leases in runWorkerEnvelope, so the width was never clamped there.
 */
export function nodeParallelism(
  context: { readonly workspaceLease?: unknown; readonly nodeWorkspaces?: "per-node" },
  configured: number,
): number {
  if (context.workspaceLease && context.nodeWorkspaces !== "per-node") return 1;
  return configured;
}

export class SupervisorBrain {
  private readonly config: SupervisorConfig;
  private readonly decomposer: SupervisorDecomposer;
  private readonly capabilityMatcher: CapabilityMatcher;
  private readonly providerAssigner: ProviderAssigner;
  private emitter?: { emit: (event: string, payload: unknown) => void };
  private readonly verifyNode?: (node: NodeResult, context: SupervisorContext) => Promise<VerificationVerdict>;
  private readonly goalStorage?: SupervisorBrainOptions["goalStorage"];

  private executeNodeFn?: (
    node: TaggedGoalNode,
    context: SupervisorContext,
    signal: AbortSignal,
  ) => Promise<NodeResult>;

  constructor(options: SupervisorBrainOptions) {
    this.config = options.config;
    this.decomposer = options.decomposer;
    this.capabilityMatcher = options.capabilityMatcher;
    this.providerAssigner = options.providerAssigner;
    this.emitter = options.eventEmitter;
    this.verifyNode = options.verifyNode;
    this.goalStorage = options.goalStorage;
  }

  // ---------------------------------------------------------------------------
  // LAZY SETTER (bootstrap circular dependency resolution)
  // ---------------------------------------------------------------------------

  /**
   * Set the event emitter for supervisor telemetry events.
   * Called after bootstrap when workspaceBus is available.
   */
  setEventEmitter(emitter: { emit: (event: string, payload: unknown) => void }): void {
    this.emitter = emitter;
  }

  /**
   * Set the executeNode callback used to run individual goal nodes.
   * Must be called before execute() or execute() will throw.
   */
  setExecuteNode(
    fn: (
      node: TaggedGoalNode,
      context: SupervisorContext,
      signal: AbortSignal,
    ) => Promise<NodeResult>,
  ): void {
    this.executeNodeFn = fn;
  }

  // ---------------------------------------------------------------------------
  // ABORT
  // ---------------------------------------------------------------------------

  private readonly activeAbortControllers = new Set<AbortController>();

  /** Abort all active work. */
  abort(): void {
    for (const controller of this.activeAbortControllers) {
      controller.abort();
    }
  }

  shouldExecute(task: string, goalTree?: GoalTree): boolean {
    return !!goalTree || this.decomposer.shouldDecompose(task);
  }

  /**
   * Calculate an adaptive per-node timeout based on actual vs expected workload.
   *
   * When decomposition succeeds and produces N nodes, each node has ~1/N of the
   * total work → the base timeout is sufficient. When decomposition fails or
   * produces a single fallback node, that node carries the full task → needs a
   * proportionally longer timeout.
   *
   * Estimation heuristic (no hardcoded multipliers):
   * - estimatedNodeCount: derived from prompt length (longer prompts = more work)
   *   using the decomposition prompt's own range guidance (2-8 sub-goals)
   * - scaleFactor: ratio of estimatedNodeCount / actualNodeCount
   * - Result is clamped to [baseTimeout, baseTimeout * MAX_SCALE_CAP]
   */
  /**
   * Calculate an adaptive per-node timeout. The timeout is a safety net for
   * truly stuck operations — it should NEVER interrupt normally-progressing work.
   *
   * Strategy:
   * - Multi-provider with many nodes: base timeout is fine (each node is small)
   * - Single provider or few nodes: scale up proportionally
   * - Single-node fallback: use the maximum possible timeout
   * - The timeout only exists to prevent resource leaks from abandoned operations
   */
  private calculateAdaptiveTimeout(
    actualNodeCount: number,
    promptLength: number,
    planSummary?: string,
  ): number {
    const base = this.config.nodeTimeoutMs;

    // Multi-node decomposition with many nodes: each node is small, base timeout works
    const isFallback = planSummary === "Fallback single-step execution";
    if (!isFallback && actualNodeCount > 3) return base;

    // Few nodes or single-node: scale timeout based on work concentration
    // estimatedNodeCount: how many nodes *would* exist if decomposition produced more
    const clampedLength = Math.min(Math.max(promptLength, 60), 600);
    const estimatedNodes = 2 + ((clampedLength - 60) / (600 - 60)) * 6;
    const workConcentration = Math.ceil(estimatedNodes) / Math.max(1, actualNodeCount);

    // Scale generously — timeout should never be the reason work fails
    return Math.round(base * Math.min(workConcentration, 6));
  }

  private emitActivity(detail: string, taskId?: string, action = "supervisor_update"): void {
    this.emitter?.emit("monitor:agent_activity", {
      ...(taskId ? { taskId } : {}),
      action,
      detail,
      timestamp: Date.now(),
    });
  }

  private emitNarrative(narrative: string, lang: string, nodeId?: string): void {
    this.emitter?.emit("progress:narrative", {
      ...(nodeId ? { nodeId } : {}),
      narrative,
      lang,
    });
  }

  private async reportUpdate(context: SupervisorContext, markdown: string): Promise<void> {
    try {
      await context.reportUpdate?.(markdown);
    } catch {
      // Progress updates are best-effort only.
    }
  }

  /**
   * Produce a display-only variant of the decomposed goal tree (re-labels the
   * task text shown in the monitor) WITHOUT changing topology.
   *
   * INVARIANT — id alignment: this MUST preserve `goalTree.rootId` and the exact
   * set of node-id keys. The monitor:dag_init payload is built from this tree,
   * while the per-node monitor:task_update stream is keyed on the *decomposed*
   * tree's node ids (see SupervisorDispatcher.emitNodeWorkspaceStatus). If the
   * ids diverged, the frontend DAG-node patch (findIndex by id) would miss and
   * the DAG node would stay static while the Kanban card updates. We only ever
   * rewrite the `.task` string on existing keys, never add/remove/relabel keys,
   * so the two streams share identical ids by construction.
   */
  private buildVisibleGoalTree(goalTree: GoalTree, task: string): GoalTree {
    const normalizedTask = task.trim();
    const originalTask = goalTree.taskDescription.trim();
    if (!normalizedTask || originalTask === normalizedTask) {
      return goalTree;
    }

    // Clone preserves every node-id key; we only overwrite the `.task` text.
    const updatedNodes = new Map(goalTree.nodes);
    for (const [nodeId, node] of goalTree.nodes.entries()) {
      if (node.task.trim() !== originalTask) {
        continue;
      }
      updatedNodes.set(nodeId, {
        ...node,
        task: normalizedTask,
      });
    }

    // Spread preserves rootId; keys are preserved by the clone above.
    return {
      ...goalTree,
      taskDescription: normalizedTask,
      nodes: updatedNodes,
    };
  }

  /**
   * Build the monitor:dag_init payload, guaranteeing its node ids match the
   * per-node monitor:task_update stream (which is keyed on the *decomposed*
   * tree's ids). `buildVisibleGoalTree` is id-preserving by construction, but
   * this is the single source of truth for the DAG payload and defensively
   * re-aligns to the decomposed topology if a future change ever diverges the
   * id set — so the DAG and Kanban can never desync.
   */
  private buildAlignedDagTree(
    decomposedGoalTree: GoalTree,
    visibleGoalTree: GoalTree,
  ): GoalTree {
    const sameRoot = String(visibleGoalTree.rootId) === String(decomposedGoalTree.rootId);
    const sameNodeIds =
      visibleGoalTree.nodes.size === decomposedGoalTree.nodes.size &&
      [...decomposedGoalTree.nodes.keys()].every((id) => visibleGoalTree.nodes.has(id));

    if (sameRoot && sameNodeIds) {
      // Common case: ids already aligned — use the relabeled (display) tree.
      return visibleGoalTree;
    }

    // Defensive fallback: ids diverged. Keep the decomposed topology/ids (so
    // the DAG matches the task_update stream) but carry over display labels for
    // any node ids that still exist in both trees.
    const realignedNodes = new Map(decomposedGoalTree.nodes);
    for (const [nodeId, node] of decomposedGoalTree.nodes.entries()) {
      const visibleNode = visibleGoalTree.nodes.get(nodeId);
      if (visibleNode && visibleNode.task !== node.task) {
        realignedNodes.set(nodeId, { ...node, task: visibleNode.task });
      }
    }
    return {
      ...decomposedGoalTree,
      taskDescription: visibleGoalTree.taskDescription,
      nodes: realignedNodes,
    };
  }

  private buildDisplayTaskLabels(
    nodes: readonly TaggedGoalNode[],
    visibleGoalTree: GoalTree,
  ): Map<string, string> {
    const labels = new Map<string, string>();
    for (const node of nodes) {
      const visibleNode = visibleGoalTree.nodes.get(node.id);
      if (!visibleNode) {
        continue;
      }
      labels.set(String(node.id), visibleNode.task);
    }
    return labels;
  }

  // ---------------------------------------------------------------------------
  // MAIN PIPELINE
  // ---------------------------------------------------------------------------

  /**
   * Execute the full supervisor pipeline for a task.
   *
   * Returns null if the task doesn't warrant decomposition.
   * Returns a SupervisorResult (possibly partial) on success, abort, or error.
   */
  async execute(
    task: string,
    context: SupervisorContext,
  ): Promise<SupervisorResult | null> {
    const planningTask = context.planningPrompt?.trim() || task;
    // Step 1: Check if decomposition is warranted
    if (!this.shouldExecute(planningTask, context.goalTree)) {
      return null;
    }

    // Guard: executeNode must be set
    if (!this.executeNodeFn) {
      throw new Error(
        "SupervisorBrain: executeNode callback not set. Call setExecuteNode() before execute().",
      );
    }

    // Merge external signal with internal abort controller
    const externalSignal = context.signal;
    const internalController = new AbortController();
    const internalSignal = internalController.signal;
    // Conversation/chat scope for per-conversation root grouping in the monitor.
    // Attached (optionally) to the dag_init + per-node task_update payloads so the
    // frontend can group this request-root under its conversation. Additive only.
    const conversationScope = resolveConversationScope(context.chatId, context.conversationId);
    let goalRootId: string | null = null;
    this.activeAbortControllers.add(internalController);

    try {
      // NOTE: We intentionally do NOT emit a blanket "monitor:clear" here.
      // It used to wipe the ENTIRE monitor board (tasks + dag + activeRootId)
      // on every supervisor run, which clobbered a prior, still-relevant task's
      // cards when a new request arrived in the same conversation (the prior
      // task looked cancelled even though it actually completed). The new run
      // re-establishes its own board via the upcoming "monitor:dag_init" — which
      // fully replaces the DAG + active root (Kanban tasks MERGE by id, not replace)
      // — so no clear is needed for correct rendering of THIS run.
      // TRADEOFF (accepted P0→P1): the prior run's cards now LINGER instead of being
      // wiped. A graceful abort/completion settles them terminal (the dispatcher
      // always emits a terminal task_update — informative, not stale); only an
      // abnormal process-death/teardown could leave an "executing" card until
      // MAX_TASKS eviction. Net win vs. clobbering completed work (BUG#5); the full
      // fix is P1 task-scoping (multi-root store + active/done segregation).

      // Step 2: Emit supervisor:activated
      this.emitter?.emit("supervisor:activated", {
        taskId: context.chatId,
        complexity: this.config.complexityThreshold,
        nodeCount: 0, // updated after decomposition
      });
      const activation = buildSupervisorActivationNarrative(task);
      this.emitNarrative(activation.narrative, activation.language);
      this.emitActivity(activation.narrative, context.chatId, "supervisor_activated");
      this.emitter?.emit("workspace:mode_suggest", {
        mode: "monitor",
        reason: activation.narrative,
      });
      await this.reportUpdate(context, activation.markdown);

      // Step 3: Decompose the task into a GoalTree
      // Planning is a model call of minutes; the task's watchdog must keep
      // hearing from it (measured 2026-09-09 17:45: aborted at 20 min of
      // "no progress" during two decomposition calls).
      const decomposedGoalTree = context.goalTree ?? await withLivenessHeartbeat(
        context.chatId,
        () => this.decomposer.decomposeProactive(context.chatId, planningTask),
        context.onLiveness,
      );
      const visibleGoalTree = this.buildVisibleGoalTree(decomposedGoalTree, task);
      goalRootId = String(decomposedGoalTree.rootId);
      // The DAG payload (and the tree handed to onGoalDecomposed, which the
      // monitor lifecycle turns into monitor:dag_init) MUST share the same
      // rootId + node ids as the dispatcher's per-node monitor:task_update
      // stream — otherwise the DAG node patch misses and the DAG stays static
      // while the Kanban updates. buildAlignedDagTree guarantees that.
      const dagTree = this.buildAlignedDagTree(decomposedGoalTree, visibleGoalTree);

      // Check abort BEFORE publishing: decomposeProactive cannot be cancelled,
      // so a lineage cancelled mid-plan (the time box at 13:04:18 on
      // 2026-09-08) used to finish minutes later and still publish its tree —
      // attachGoalRoot, goalStorage, and the monitor episode re-rooted onto a
      // task that was already gone, beside the resubmission's own plan.
      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult([], "Aborted after decomposition");
      }
      context.onGoalDecomposed?.(dagTree);
      if (!context.onGoalDecomposed) {
        this.emitter?.emit("monitor:dag_init", goalTreeToDagPayload(dagTree, conversationScope));
      }

      // Step 4: Extract leaf nodes (non-root nodes)
      const MAX_SUPERVISOR_NODES = 50;
      const leafNodes = this.extractLeafNodes(decomposedGoalTree);

      if (leafNodes.length > MAX_SUPERVISOR_NODES) {
        return this.makePartialResult([],
          `Task decomposed into ${leafNodes.length} sub-tasks, exceeding the limit of ${MAX_SUPERVISOR_NODES}. Please break your request into smaller tasks.`);
      }

      if (leafNodes.length === 0) {
        const alreadyDone = completedPlanOnResume(context.goalTree);
        if (alreadyDone) {
          // A node's "completed" status is persisted before the independent
          // verifier runs, so a tree saved between the two carries unverified
          // work (Codex 2026-09-11 #1). The saved results are re-verified here,
          // every one of them, before the resume may count as done.
          if (this.verifyNode) {
            const verifier = new ResultAggregator({
              mode: "always",
              samplingRate: 1,
              preferDifferentProvider: true,
              maxVerificationCost: Number.POSITIVE_INFINITY,
            }, stopAfterDeadline((node: NodeResult) => this.verifyNode!(node, context), () => verifyDeadlinePassed));
            // The verification itself is a model call per node: keep the
            // task's watchdog hearing from us, or a slow reviewer reads as an
            // inactive task (Codex 2026-09-11 C#7).
            // A verifier that never settles used to hold the resume open while
            // the heartbeat reported liveness (Codex 2026-09-11 D#7). The
            // whole batch gets a deadline; past it the resume fails honestly.
            let verifyDeadlinePassed = false;
            const verifyDeadlineMs = Math.max(
              RESUME_VERIFY_MIN_MS,
              (this.config.nodeTimeoutMs ?? RESUME_VERIFY_MIN_MS) * Math.max(1, alreadyDone.nodeResults.length),
            );
            const verifiedOrTimeout = await withLivenessHeartbeat(
              context.chatId,
              () => Promise.race([
                verifier.verifyWithReport(alreadyDone.nodeResults),
                new Promise<"timeout">((resolve) => setTimeout(() => {
                  verifyDeadlinePassed = true;
                  resolve("timeout");
                }, verifyDeadlineMs).unref?.()),
              ]),
              context.onLiveness,
            );
            if (verifiedOrTimeout === "timeout") {
              getLoggerSafe().warn("Resume re-verification timed out — the saved plan is not counted as done", {
                goalRootId,
                steps: alreadyDone.totalNodes,
                deadlineMs: verifyDeadlineMs,
              });
              return this.makePartialResult(
                [],
                `The saved plan could not be re-verified within ${Math.round(verifyDeadlineMs / 1000)} s, so it is not counted as done.`,
              );
            }
            const { results: verified, report } = verifiedOrTimeout;
            if (externalSignal?.aborted || internalSignal.aborted) {
              return this.makePartialResult([], "Aborted during resume re-verification");
            }
            const synthesized = verifier.synthesize(verified);
            // NOBODY LOOKED is not approval (C#4): a resume counts as done
            // only when every saved node was actually approved. A flagged or
            // unverified node keeps its explanation in the output.
            const unapproved = report.candidates - report.approved;
            if (unapproved > 0) {
              const detail = verified
                .filter((r) => r.status !== "ok" || (r.output ?? "").length > 0)
                .map((r) => `- ${String(r.nodeId)}: ${(r.output ?? "").slice(0, 200) || r.status}`)
                .slice(0, 8)
                .join("\n");
              // A REJECTED step is no longer a completed checkpoint: writing
              // it back as failed makes the next retry re-run the work rather
              // than re-verify the same saved output (Codex 2026-09-11 C#5).
              // Its DEPENDENTS go with it: a node whose input changed cannot
              // keep its old "completed" (D#5), and the write preserves the
              // result and retry counts the node already carried (D#18).
              const rejected = new Set(verified.filter((r) => r.status !== "ok").map((r) => String(r.nodeId)));
              const errorFor = new Map(verified.filter((r) => r.status !== "ok").map((r) => [String(r.nodeId), (r.output ?? "").slice(0, 500)]));
              for (const id of dependentClosure(context.goalTree, rejected)) {
                const node = context.goalTree?.nodes.get(id as GoalNodeId);
                const why = errorFor.get(id)
                  ?? "a step this one depends on was rejected on resume; its input may have changed";
                try {
                  this.goalStorage?.updateNodeStatus(
                    id as GoalNodeId,
                    "failed",
                    node?.result,
                    why,
                    node?.retryCount,
                    node?.redecompositionCount,
                    node?.reviewStatus,
                    node?.reviewIterations,
                  );
                } catch {
                  /* persistence is best effort; the returned result still says failed */
                }
              }
              return {
                ...synthesized,
                success: false,
                partial: true,
                output:
                  `The saved plan was re-verified on resume and ${unapproved} of ${report.candidates} step(s) did not pass: ` +
                  `${report.approved} approved, ${report.flagged} flagged, ${report.rejected} rejected.\n${detail}`,
              };
            }
            getLoggerSafe().info("Saved plan already complete on resume — re-verified before counting it done", {
              goalRootId,
              steps: alreadyDone.totalNodes,
              approved: report.approved,
              rejected: report.rejected,
              flagged: report.flagged,
              success: synthesized.success,
            });
            return synthesized.success
              ? { ...synthesized, output: `${alreadyDone.output}\n\nRe-verified on resume: ${report.approved} of ${report.candidates} step(s) approved.` }
              : synthesized;
          }
          getLoggerSafe().info("Saved plan already complete on resume — nothing left to run (no verifier configured)", {
            goalRootId,
            steps: alreadyDone.totalNodes,
          });
          return alreadyDone;
        }
        return this.makePartialResult([], "No sub-tasks after decomposition");
      }

      // Step 5: Match capabilities
      const taggedNodes = await this.capabilityMatcher.matchNodes(leafNodes);

      // Check abort after matching
      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult([], "Aborted after capability matching");
      }

      // Step 6: Assign providers
      const assignedNodes = this.providerAssigner.assignNodes(
        taggedNodes,
        this.config.diversityCap,
      );
      const displayTaskLabels = this.buildDisplayTaskLabels(assignedNodes, visibleGoalTree);
      const visibleAssignedNodes = assignedNodes.map((node) => ({
        ...node,
        task: displayTaskLabels.get(String(node.id)) ?? node.task,
      }));

      const dispatchSignal = externalSignal ? AbortSignal.any([externalSignal, internalSignal]) : internalSignal;
      // The execute-node bridge carries a node's completed dependencies into
      // its prompt by reading `context.goalTree`. That tree was never set on
      // the fresh-decomposition path (the decomposition stayed LOCAL here), and
      // no path ever wrote a finished node's output back into any tree — so a
      // wave-2 worker received its one-line task and nothing of what wave 1
      // returned as prose. Dispatch against a live copy of the decomposed tree
      // and record each ok node's output before the next wave launches (the
      // dispatcher awaits the whole wave, so the write is race-free).
      // Audited 2026-09-02.
      const liveNodes = new Map(decomposedGoalTree.nodes);
      const liveGoalTree: GoalTree = { ...decomposedGoalTree, nodes: liveNodes };
      const dispatchContext: SupervisorContext = {
        ...context,
        signal: dispatchSignal,
        goalTree: liveGoalTree,
      };
      const executeNodeFn = this.executeNodeFn;
      const dispatcher = new SupervisorDispatcher({
        onLiveness: context.onLiveness,
        executeNode: async (node: TaggedGoalNode, nodeSignal: AbortSignal) => {
          const nodeResult = await executeNodeFn(node, dispatchContext, nodeSignal);
          const previous = liveNodes.get(node.id);
          if (previous && nodeResult.status === "ok") {
            liveNodes.set(node.id, {
              ...previous,
              status: "completed",
              result: nodeResult.output,
              updatedAt: Date.now(),
            });
          }
          return nodeResult;
        },
        config: {
          maxParallelNodes: nodeParallelism(context, this.config.maxParallelNodes),
          nodeTimeoutMs: this.calculateAdaptiveTimeout(
            assignedNodes.length,
            planningTask.length,
            decomposedGoalTree.planSummary,
          ),
          maxFailureBudget: this.config.maxFailureBudget,
        },
        eventEmitter: this.emitter,
        rootId: String(decomposedGoalTree.rootId),
        conversationId: conversationScope,
        taskDescription: task,
        displayTaskLabels,
      });
      const waves = dispatcher.computeWaves(assignedNodes);

      // Step 7: Emit supervisor:plan_ready
      const assignments: Record<string, { provider: string; model: string }> = {};
      for (const node of assignedNodes) {
        assignments[node.id] = {
          provider: node.assignedProvider ?? "unassigned",
          model: node.assignedModel ?? "unknown",
        };
      }
      this.emitter?.emit("supervisor:plan_ready", {
        dag: { rootId: decomposedGoalTree.rootId, nodeCount: assignedNodes.length },
        assignments,
      });
      const plan = buildSupervisorPlanNarrative({
        task,
        nodeCount: assignedNodes.length,
        nodes: visibleAssignedNodes,
        totalWaves: waves.length,
        fallback: decomposedGoalTree.planSummary === "Fallback single-step execution",
      });
      this.emitNarrative(plan.narrative, plan.language);
      this.emitActivity(plan.narrative, context.chatId, "supervisor_plan_ready");
      this.emitter?.emit("canvas:agent_draw", buildSupervisorCanvasPlan({
        rootId: String(decomposedGoalTree.rootId),
        task,
        nodes: visibleAssignedNodes,
        summary: plan.canvasSummary,
      }));
      await this.reportUpdate(context, plan.markdown);

      // Check abort after assignment
      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult([], "Aborted after provider assignment");
      }

      const results = await dispatcher.dispatch(assignedNodes, dispatchSignal);

      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult(results, "Aborted during node execution");
      }

      // Step 10-12: Create aggregator, verify, and synthesize
      const verificationBudget = results.reduce((sum, result) => sum + Math.max(result.cost, 0), 0);
      const criticalNodeIds = new Set(
        assignedNodes
          .filter((node) => this.shouldVerifyCriticalNode(node))
          .map((node) => String(node.id)),
      );
      const aggregator = new ResultAggregator({
        mode: this.config.verificationMode,
        samplingRate: this.config.verificationBudgetPct / 100,
        preferDifferentProvider: true,
        maxVerificationCost:
          verificationBudget > 0
            ? verificationBudget * (this.config.verificationBudgetPct / 100)
            : Number.POSITIVE_INFINITY,
      }, this.verifyNode ? (node) => {
        if (
          this.config.verificationMode === "critical-only" &&
          !criticalNodeIds.has(String(node.nodeId))
        ) {
          // Not a verdict: nobody looked. Used to answer "approve" here, so a
          // run with zero critical nodes reported a clean pass (audited 2026-09-02).
          return Promise.resolve({
            verdict: "skipped" as const,
            issues: ["not a critical node under critical-only verification"],
            verifierProvider: canonicalizeProviderName(node.provider) ?? node.provider,
          });
        }
        // BOUNDED: a verifier that never settles used to hold the execution
        // slot for ever (Codex 2026-09-11 M#12).
        return withVerifyDeadline((n: NodeResult) => this.verifyNode!(n, context), VERIFY_TIMEOUT_MS, context.signal)(node);
      } : undefined,
      // audited 2026-09-02: the report's `candidates` counted every ok node even
      // in critical-only mode, so a run that verified all of its critical nodes
      // announced "1 of 3 ok nodes independently verified" — two nodes the mode
      // was never going to look at, counted as unverified. The mode's own scope
      // is the denominator; the sentence below names which scope it measured.
      this.config.verificationMode === "critical-only"
        ? (result: NodeResult) => criticalNodeIds.has(String(result.nodeId))
        : undefined);

      // audited 2026-09-02: verify_start, the "cross-checking" narrative and
      // verify_done were emitted around a verify() that is a no-op when the mode
      // is disabled, no verifier is wired, or no node qualifies — and the verdict
      // came from "did any ok node get downgraded", so nothing verified read as
      // "approve". Emit only when a verifier can actually look at something, and
      // derive the verdict from what it measured.
      const verificationPlanned =
        this.config.verificationMode !== "disabled" &&
        this.verifyNode !== undefined &&
        results.some((result) =>
          result.status === "ok" &&
          (this.config.verificationMode !== "critical-only" || criticalNodeIds.has(String(result.nodeId))),
        );
      if (verificationPlanned) {
        this.emitter?.emit("supervisor:verify_start", { nodeId: "aggregate", verifierProvider: "internal" });
        const verification = buildSupervisorVerificationNarrative(task);
        this.emitNarrative(verification.narrative, verification.language);
        this.emitActivity(verification.narrative, "aggregate", "supervisor_verify_start");
        this.emitter?.emit("canvas:agent_draw", buildSupervisorCanvasSummaryUpdate({
          rootId: String(decomposedGoalTree.rootId),
          summary: verification.canvasSummary,
          tone: "active",
        }));
        await this.reportUpdate(context, verification.markdown);
      }
      const { results: verifiedResults, report: verificationReport } =
        await aggregator.verifyWithReport(results);
      this.recordProviderOutcomes(assignedNodes, verifiedResults);
      const verificationVerdict =
        verificationReport.verified === 0
          ? "not_verified"
          : verificationReport.rejected > 0
            ? "reject"
            : verificationReport.flagged > 0
              ? "flag_issues"
              : "approve";

      // Emit per-node monitor:task_update for verification-rejected nodes
      for (let i = 0; i < verifiedResults.length; i++) {
        if (results[i]?.status === "ok" && verifiedResults[i]?.status !== "ok") {
          const rejectedStatus = verifiedResults[i]!.status === "failed" ? "failed" : "skipped";
          this.emitter?.emit("monitor:task_update", {
            rootId: String(decomposedGoalTree.rootId),
            nodeId: String(verifiedResults[i]!.nodeId),
            status: rejectedStatus,
            completedAt: Date.now(),
            conversationId: conversationScope,
          });
          // Emit narrative for rejected nodes
          this.emitNarrative(
            `Node rejected by verification: ${verifiedResults[i]!.output?.slice(0, 200) || "quality check failed"}`,
            "en",
            String(verifiedResults[i]!.nodeId),
          );
        }
      }

      // A REJECTED NODE TAKES ITS DEPENDENTS WITH IT, on the ordinary path as
      // well as on resume. Normal verification invalidated only the rejected
      // node, so a retry re-ran it alone and the work built against its old
      // output stayed "completed": A produced an API, B wired a scene against
      // it, A was rejected and rebuilt, and B still referenced version one
      // (Codex 2026-09-11 M#7).
      const rejectedNow = new Set(
        verifiedResults
          .filter((r, i) => results[i]?.status === "ok" && r.status !== "ok")
          .map((r) => String(r.nodeId)),
      );
      if (rejectedNow.size > 0 && this.goalStorage) {
        // THE LIVE TREE, and the rejected nodes themselves. Reading
        // `decomposedGoalTree` saw the statuses the plan was DISPATCHED with —
        // every node still "pending" — so the closure skipped them all and the
        // invalidation wrote nothing at all (Codex 2026-09-12 P#2). And the
        // aggregator has no storage writer: the rejected node's own row was
        // never written either.
        for (const id of invalidationTargets(liveGoalTree, rejectedNow)) {
          const node = liveNodes.get(id as GoalNodeId);
          if (!node) continue;
          try {
            this.goalStorage.updateNodeStatus(
              id as GoalNodeId,
              "failed",
              node.result,
              rejectedNow.has(id)
                ? "rejected by verification"
                : "a step this one depends on was rejected by verification; its input changed",
              node.retryCount,
              node.redecompositionCount,
              node.reviewStatus,
              node.reviewIterations,
            );
          } catch {
            /* the tree may have moved on; the rejection itself still stands */
          }
        }
      }

      if (verificationPlanned) {
        this.emitter?.emit("supervisor:verify_done", {
          nodeId: "aggregate",
          verdict: verificationVerdict,
          issues: [
            `${verificationReport.verified} of ${verificationReport.candidates}` +
            ` ${this.config.verificationMode === "critical-only" ? "critical nodes" : "ok nodes"}` +
            ` independently verified` +
            ` (approved ${verificationReport.approved}, flagged ${verificationReport.flagged}, rejected ${verificationReport.rejected})`,
          ],
        });
      }
      const supervisorResult = aggregator.synthesize(verifiedResults);

      // Step 13: Emit supervisor:complete
      this.emitter?.emit("supervisor:complete", {
        totalNodes: supervisorResult.totalNodes,
        succeeded: supervisorResult.succeeded,
        failed: supervisorResult.failed,
        blocked: 0,
        skipped: supervisorResult.skipped,
        cost: supervisorResult.totalCost,
        duration: supervisorResult.totalDuration,
      });
      const completion = buildSupervisorCompletionNarrative({
        task,
        result: supervisorResult,
        verification: {
          verified: verificationReport.verified,
          candidates: verificationReport.candidates,
          scopeLabel: this.config.verificationMode === "critical-only" ? "critical nodes" : "nodes",
        },
      });
      this.emitNarrative(completion.narrative, completion.language);
      this.emitActivity(completion.narrative, context.chatId, "supervisor_complete");
      this.emitter?.emit("canvas:agent_draw", buildSupervisorCanvasSummaryUpdate({
        rootId: String(decomposedGoalTree.rootId),
        summary: completion.canvasSummary,
        tone: supervisorResult.failed > 0 ? "error" : "success",
      }));

      return supervisorResult;
    } catch (err: unknown) {
      const { getLogger } = await import("../utils/logger.js");
      const logger = getLogger?.();
      logger?.warn("Supervisor pipeline error", { error: err instanceof Error ? err.message : String(err) });
      const abort = buildSupervisorAbortNarrative({
        task,
        reason: err instanceof Error ? err.message : String(err),
      });
      this.emitNarrative(abort.narrative, abort.language);
      this.emitActivity(abort.narrative, context.chatId, "supervisor_aborted");
      this.emitter?.emit("supervisor:aborted", {
        reason: err instanceof Error ? err.message : String(err),
        completedNodes: 0,
        partialResult: false,
      });
      this.emitter?.emit("canvas:agent_draw", buildSupervisorCanvasSummaryUpdate({
        rootId: goalRootId ?? context.chatId,
        summary: abort.canvasSummary,
        tone: "error",
      }));
      // Name the actual cause. The generic "An error occurred during task
      // execution" swallowed "All providers are in cooldown" — downstream,
      // the campaign's reconcile defers on provider-outage wording and the
      // keep-alive classifies it, so the generic text made a quota outage
      // count as a failed milestone attempt (measured 2026-08-29 12:36:
      // Sprint 3 stopped "after 2 attempts" that were both the same quota
      // wall). Sliced defensively; sanitizeToolResult-level redaction is not
      // needed for provider-chain error strings.
      const cause = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      return this.makePartialResult([], `Task execution failed: ${cause}`);
    } finally {
      this.activeAbortControllers.delete(internalController);
    }
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Extract the leaf nodes of a GoalTree — the units of work to dispatch.
   *
   * COMPLETED nodes are excluded: prepareTreeForRetry deliberately preserves
   * them with their results so a replay resumes instead of restarting — but
   * this extractor used to return every node regardless of status, so the
   * "don't redo finished work" contract was cosmetic and each retry re-ran
   * (and re-billed) the whole wave plan from wave 1.
   *
   * Nodes WITH children are excluded too (audited 2026-09-02): a depth-1 node
   * the planner flagged needsFurtherDecomposition stays "pending" with its
   * depth-2 children under it, and this filter only dropped the root — so the
   * scaffolding parent was dispatched as work in the same wave as the children
   * created to split it, implementing the sub-goal twice. Same rule as
   * countDispatchableGoals (tree-shape.ts): a parent whose children carry the
   * work is scaffolding, not a unit of work.
   *
   * Dropping the parent is not enough: computeWaves treats a dependsOn id that
   * is not in the dispatched set as already resolved, so a sibling that
   * depended on the parent launched in wave 0 next to the parent's own children
   * (reproduced: start:C1 start:C2 start:S1). Every edge that touched the
   * parent is therefore rewired onto the leaves that replace it — a dependent
   * of P now depends on P's leaf descendants, and P's leaves inherit what P
   * itself waited for — so the plan's ordering survives the substitution and
   * the execute-node bridge (which reads node.dependsOn against the tree) can
   * carry the leaves' results forward.
   */
  private extractLeafNodes(tree: GoalTree): GoalNode[] {
    const deps = effectiveLeafDependencies(tree);
    const nodes: GoalNode[] = [];
    for (const [id, node] of tree.nodes) {
      if (node.status === "completed") continue;
      const rewired = deps.get(String(id));
      if (!rewired) continue; // the root, or a scaffolding parent
      const asIds = [...rewired] as GoalNodeId[];
      const unchanged =
        asIds.length === node.dependsOn.length &&
        asIds.every((depId, index) => node.dependsOn[index] === depId);
      nodes.push(unchanged ? node : { ...node, dependsOn: asIds });
    }
    return nodes;
  }

  private recordProviderOutcomes(nodes: readonly TaggedGoalNode[], results: readonly NodeResult[]): void {
    const capabilityByNode = new Map<string, readonly import("./supervisor-types.js").CapabilityTag[]>();
    for (const node of nodes) {
      capabilityByNode.set(String(node.id), [...node.capabilityProfile.primary]);
    }

    for (const result of results) {
      const tags = capabilityByNode.get(String(result.nodeId));
      if (!tags || tags.length === 0 || result.status === "skipped") {
        continue;
      }
      this.providerAssigner.recordOutcome(result.provider, [...tags], result.status === "ok");
    }
  }

  private shouldVerifyCriticalNode(node: TaggedGoalNode): boolean {
    return /\bcritical\b|\bsecurity\b|\bproduction\b|\breview carefully\b/i.test(node.task)
      || (
        node.capabilityProfile.preference === "quality" &&
        node.capabilityProfile.confidence >= 0.7
      )
      || node.capabilityProfile.primary.includes("reasoning")
      || node.capabilityProfile.primary.includes("vision");
  }

  /**
   * Build a partial SupervisorResult from whatever results are available.
   */
  private makePartialResult(
    nodeResults: NodeResult[],
    reason: string,
  ): SupervisorResult {
    const succeeded = nodeResults.filter((r) => r.status === "ok").length;
    const failed = nodeResults.filter((r) => r.status === "failed").length;
    const skipped = nodeResults.filter((r) => r.status === "skipped").length;
    // A node carrying a blockedReason stopped on a question, not an error.
    const blocked = nodeResults.filter(
      (r) => r.blockedReason !== undefined && r.blockedReason.trim() !== "",
    ).length;

    return {
      success: false,
      partial: true,
      output: reason,
      totalNodes: nodeResults.length,
      succeeded,
      failed,
      blocked,
      skipped,
      totalCost: nodeResults.reduce((sum, r) => sum + r.cost, 0),
      totalDuration: nodeResults.reduce((max, r) => Math.max(max, r.duration), 0),
      nodeResults,
    };
  }
}

/**
 * A resumed task carries the tree it saved. When every leaf of that tree is
 * already completed, the plan is DONE — not "No sub-tasks after decomposition".
 * Measured 2026-09-10 21:20: the driver mission's three leaves completed at
 * 20:41, the restart re-armed its task, the leaf filter (which drops completed
 * nodes) yielded nothing, the task was blocked twice and a fresh re-plan was
 * started against work that had already landed.
 */
/**
 * The rejected nodes and everything that depends on them, transitively. A
 * dependent's saved "completed" describes work done against an input that is
 * about to change (Codex 2026-09-11 D#5).
 */
/** Floor for the resume re-verification deadline. */
const RESUME_VERIFY_MIN_MS = 120_000;

/**
 * Every leaf's EFFECTIVE dependencies — the same list the executor schedules
 * on. One function because invalidation used to compute its own version and
 * the two disagreed in both directions: a consumer of a rejected node's
 * scaffolding parent stayed "completed" (Codex 2026-09-11 G#1) while an
 * independent sibling was rebuilt for its neighbour's failure (G#7).
 *
 * The rules, all three of them load-bearing:
 *  - a dependency on scaffolding means its leaves;
 *  - a leaf inherits every scaffolding ancestor's own dependencies;
 *  - a dependency on the node's OWN ancestor is already satisfied by the
 *    node's place in that subtree, and expanding it manufactured a cycle
 *    (review of 25fa96d0, 2026-09-02).
 *
 * Keyed by leaf id; scaffolding parents and the root are absent.
 */
export function effectiveLeafDependencies(tree: GoalTree): Map<string, Set<string>> {
  const childrenOf = new Map<string, GoalNodeId[]>();
  for (const [, node] of tree.nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(String(node.parentId));
    if (siblings) siblings.push(node.id);
    else childrenOf.set(String(node.parentId), [node.id]);
  }
  const isScaffolding = (id: GoalNodeId): boolean => id !== tree.rootId && childrenOf.has(String(id));

  // Leaf descendants of a scaffolding node, memoised; a malformed parent
  // chain cannot loop because `visiting` stops re-entry.
  const leavesUnder = new Map<string, GoalNodeId[]>();
  const collectLeaves = (id: GoalNodeId, visiting: Set<string>): GoalNodeId[] => {
    const cached = leavesUnder.get(String(id));
    if (cached) return cached;
    if (visiting.has(String(id))) return [];
    visiting.add(String(id));
    const leaves: GoalNodeId[] = [];
    for (const childId of childrenOf.get(String(id)) ?? []) {
      if (isScaffolding(childId)) leaves.push(...collectLeaves(childId, visiting));
      else leaves.push(childId);
    }
    leavesUnder.set(String(id), leaves);
    return leaves;
  };

  const isAncestorOf = (candidateId: GoalNodeId, nodeId: GoalNodeId): boolean => {
    const seen = new Set<string>();
    let current = tree.nodes.get(nodeId)?.parentId ?? null;
    while (current !== null && !seen.has(String(current))) {
      if (String(current) === String(candidateId)) return true;
      seen.add(String(current));
      current = tree.nodes.get(current)?.parentId ?? null;
    }
    return false;
  };

  const rewire = (nodeId: GoalNodeId, deps: readonly GoalNodeId[], into: Set<string>): void => {
    for (const depId of deps) {
      if (!isScaffolding(depId)) {
        if (String(depId) !== String(nodeId)) into.add(String(depId));
        continue;
      }
      if (isAncestorOf(depId, nodeId)) continue;
      for (const leafId of collectLeaves(depId, new Set())) {
        if (String(leafId) !== String(nodeId)) into.add(String(leafId));
      }
    }
  };

  const out = new Map<string, Set<string>>();
  for (const [id, node] of tree.nodes) {
    if (id === tree.rootId || isScaffolding(id)) continue;
    const deps = new Set<string>();
    rewire(id, node.dependsOn, deps);
    // Inherit every scaffolding ancestor's own dependencies: P waited on Q,
    // so the leaves doing P's work wait on Q.
    const seenAncestors = new Set<string>();
    let ancestorId = node.parentId;
    while (ancestorId !== null && ancestorId !== tree.rootId && !seenAncestors.has(String(ancestorId))) {
      seenAncestors.add(String(ancestorId));
      const ancestor = tree.nodes.get(ancestorId);
      if (!ancestor) break;
      rewire(id, ancestor.dependsOn, deps);
      ancestorId = ancestor.parentId;
    }
    out.set(String(id), deps);
  }
  return out;
}

export function dependentClosure(tree: GoalTree | undefined, rejected: ReadonlySet<string>): string[] {
  if (!tree) return [...rejected];
  const deps = effectiveLeafDependencies(tree);
  const out = new Set(rejected);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, nodeDeps] of deps) {
      if (out.has(id)) continue;
      for (const dep of nodeDeps) {
        if (out.has(dep)) {
          out.add(id);
          grew = true;
          break;
        }
      }
    }
  }
  return [...out];
}

/**
 * Wrap a per-node verification so that NOTHING NEW STARTS once the batch
 * deadline has passed. `Promise.race` resolves the caller but does not cancel
 * the aggregator, so a timed-out resume kept launching model calls behind the
 * verdict it had already returned (Codex 2026-09-11 E#11). The call already in
 * flight cannot be recalled; every call after the deadline is refused.
 */
/** How long one node's verification may take before it is given up on. */
export const VERIFY_TIMEOUT_MS = 5 * 60_000;

/**
 * Bound a verification call.
 *
 * The normal post-dispatch path awaited a call with no deadline and no abort
 * race, so a verifier that never settles held its execution slot for ever:
 * abort could not reach the `finally` that releases it, and with concurrency 1
 * the whole queue stopped behind it (Codex 2026-09-11 M#12). A verification
 * nobody answered is "not verified", which is what an unanswered check means.
 */
export function withVerifyDeadline<N>(
  verify: (node: N) => Promise<VerificationVerdict>,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
  signal?: AbortSignal,
): (node: N) => Promise<VerificationVerdict> {
  return async (node) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        verify(node),
        new Promise<VerificationVerdict>((resolve) => {
          timer = setTimeout(
            () => resolve({
              verdict: "skipped",
              issues: [`verification did not answer within ${Math.round(timeoutMs / 1000)}s`],
              verifierProvider: "timeout",
            }),
            timeoutMs,
          );
          timer.unref?.();
          if (signal) {
            onAbort = (): void => resolve({
              verdict: "skipped",
              issues: ["verification abandoned: the run was aborted"],
              verifierProvider: "aborted",
            });
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * Which node rows a verification rejection must rewrite: the rejected nodes
 * themselves, and every COMPLETED node that depends on them.
 *
 * The caller used to read the tree as it was DISPATCHED, where every node is
 * still "pending", so the closure skipped everything and the invalidation
 * wrote nothing at all (Codex 2026-09-12 P#2). Pure, so the behaviour can be
 * measured instead of the source text.
 */
export function invalidationTargets(tree: GoalTree | undefined, rejected: ReadonlySet<string>): string[] {
  const out: string[] = [...rejected];
  for (const id of dependentClosure(tree, rejected)) {
    if (rejected.has(id)) continue;
    if (tree?.nodes.get(id as GoalNodeId)?.status !== "completed") continue;
    out.push(id);
  }
  return out;
}

export function stopAfterDeadline<N, R>(
  verify: (node: N) => Promise<R>,
  deadlinePassed: () => boolean,
): (node: N) => Promise<R> {
  return (node) => {
    if (deadlinePassed()) {
      return Promise.reject(new Error("resume re-verification deadline passed before this node was verified"));
    }
    return verify(node);
  };
}

export function completedPlanOnResume(tree: GoalTree | undefined): SupervisorResult | null {
  if (!tree) return null;
  const hasChildren = new Set<string>();
  for (const [, node] of tree.nodes) {
    if (node.parentId !== null) hasChildren.add(String(node.parentId));
  }
  const leaves: GoalNode[] = [];
  for (const [id, node] of tree.nodes) {
    if (id === tree.rootId || hasChildren.has(String(id))) continue;
    leaves.push(node);
  }
  if (leaves.length === 0 || leaves.some((n) => n.status !== "completed")) return null;
  const nodeResults: NodeResult[] = leaves.map((n) => ({
    nodeId: n.id,
    status: "ok",
    output: n.result ?? "",
    artifacts: [],
    toolResults: [],
    provider: "resume",
    model: "saved-plan",
    cost: 0,
    duration: Math.max(0, (n.completedAt ?? n.updatedAt) - (n.startedAt ?? n.createdAt)),
  }));
  return {
    success: true,
    partial: false,
    output: `All ${leaves.length} planned steps were already completed before this resume; nothing was left to run.\n\n`
      + leaves.map((n, i) => `${i + 1}. ${n.task.slice(0, 160)}${n.task.length > 160 ? "…" : ""}`).join("\n"),
    totalNodes: leaves.length,
    succeeded: leaves.length,
    failed: 0,
    blocked: 0,
    skipped: 0,
    totalCost: 0,
    totalDuration: nodeResults.reduce((max, r) => Math.max(max, r.duration), 0),
    nodeResults,
  };
}
