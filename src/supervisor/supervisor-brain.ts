/**
 * SupervisorBrain — Pipeline orchestrator for multi-provider task decomposition.
 *
 * Ties together the full supervisor pipeline:
 *   GoalDecomposer → CapabilityMatcher → ProviderAssigner → SupervisorDispatcher → ResultAggregator
 *
 * Handles abort signals, emits telemetry events, and returns partial results
 * when the pipeline is interrupted mid-execution.
 */

import type { GoalNode, GoalTree } from "../goals/types.js";
import type {
  NodeResult,
  SupervisorConfig,
  SupervisorContext,
  SupervisorResult,
  TaggedGoalNode,
  VerificationVerdict,
} from "./supervisor-types.js";
import { canonicalizeProviderName } from "../agents/providers/provider-identity.js";
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
}

// =============================================================================
// SUPERVISOR BRAIN
// =============================================================================

export class SupervisorBrain {
  private readonly config: SupervisorConfig;
  private readonly decomposer: SupervisorDecomposer;
  private readonly capabilityMatcher: CapabilityMatcher;
  private readonly providerAssigner: ProviderAssigner;
  private emitter?: { emit: (event: string, payload: unknown) => void };
  private readonly verifyNode?: (node: NodeResult, context: SupervisorContext) => Promise<VerificationVerdict>;

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

  private buildVisibleGoalTree(goalTree: GoalTree, task: string): GoalTree {
    const normalizedTask = task.trim();
    const originalTask = goalTree.taskDescription.trim();
    if (!normalizedTask || originalTask === normalizedTask) {
      return goalTree;
    }

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

    return {
      ...goalTree,
      taskDescription: normalizedTask,
      nodes: updatedNodes,
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
    let goalRootId: string | null = null;
    this.activeAbortControllers.add(internalController);

    try {
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
      const decomposedGoalTree = context.goalTree ?? await this.decomposer.decomposeProactive(
        context.chatId,
        planningTask,
      );
      const visibleGoalTree = this.buildVisibleGoalTree(decomposedGoalTree, task);
      goalRootId = String(decomposedGoalTree.rootId);
      context.onGoalDecomposed?.(visibleGoalTree);
      if (!context.onGoalDecomposed) {
        this.emitter?.emit("monitor:dag_init", goalTreeToDagPayload(visibleGoalTree));
      }

      // Check abort after decomposition
      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult([], "Aborted after decomposition");
      }

      // Step 4: Extract leaf nodes (non-root nodes)
      const MAX_SUPERVISOR_NODES = 50;
      const leafNodes = this.extractLeafNodes(decomposedGoalTree);

      if (leafNodes.length > MAX_SUPERVISOR_NODES) {
        return this.makePartialResult([],
          `Task decomposed into ${leafNodes.length} sub-tasks, exceeding the limit of ${MAX_SUPERVISOR_NODES}. Please break your request into smaller tasks.`);
      }

      if (leafNodes.length === 0) {
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
      const dispatchContext: SupervisorContext =
        context.signal === dispatchSignal
          ? context
          : {
              ...context,
              signal: dispatchSignal,
            };
      const executeNodeFn = this.executeNodeFn;
      const dispatcher = new SupervisorDispatcher({
        executeNode: (node: TaggedGoalNode, nodeSignal: AbortSignal) =>
          executeNodeFn(node, dispatchContext, nodeSignal),
        config: {
          maxParallelNodes: context.workspaceLease ? 1 : this.config.maxParallelNodes,
          nodeTimeoutMs: this.config.nodeTimeoutMs,
          maxFailureBudget: this.config.maxFailureBudget,
        },
        eventEmitter: this.emitter,
        rootId: String(decomposedGoalTree.rootId),
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
          return Promise.resolve({
            verdict: "approve" as const,
            verifierProvider: canonicalizeProviderName(node.provider) ?? node.provider,
          });
        }
        return this.verifyNode!(node, context);
      } : undefined);

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
      const verifiedResults = await aggregator.verify(results);
      this.recordProviderOutcomes(assignedNodes, verifiedResults);
      const verificationVerdict = verifiedResults.some((result, index) =>
        results[index]?.status === "ok" && result.status !== "ok"
      )
        ? "reject"
        : "approve";

      // Emit per-node monitor:task_update for verification-rejected nodes
      for (let i = 0; i < verifiedResults.length; i++) {
        if (results[i]?.status === "ok" && verifiedResults[i]?.status !== "ok") {
          this.emitter?.emit("monitor:task_update", {
            rootId: String(decomposedGoalTree.rootId),
            nodeId: String(verifiedResults[i]!.nodeId),
            status: verifiedResults[i]!.status === "failed" ? "failed" : "skipped",
            completedAt: Date.now(),
          });
        }
      }

      this.emitter?.emit("supervisor:verify_done", {
        nodeId: "aggregate",
        verdict: verificationVerdict,
      });
      const supervisorResult = aggregator.synthesize(verifiedResults);

      // Step 13: Emit supervisor:complete
      this.emitter?.emit("supervisor:complete", {
        totalNodes: supervisorResult.totalNodes,
        succeeded: supervisorResult.succeeded,
        failed: supervisorResult.failed,
        skipped: supervisorResult.skipped,
        cost: supervisorResult.totalCost,
        duration: supervisorResult.totalDuration,
      });
      const completion = buildSupervisorCompletionNarrative({
        task,
        result: supervisorResult,
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
      return this.makePartialResult([], "An error occurred during task execution. Please try again.");
    } finally {
      this.activeAbortControllers.delete(internalController);
    }
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Extract non-root nodes from a GoalTree (leaf/child nodes that need execution).
   */
  private extractLeafNodes(tree: GoalTree): GoalNode[] {
    const nodes: GoalNode[] = [];
    for (const [id, node] of tree.nodes) {
      if (id !== tree.rootId) {
        nodes.push(node);
      }
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

    return {
      success: false,
      partial: true,
      output: reason,
      totalNodes: nodeResults.length,
      succeeded,
      failed,
      skipped,
      totalCost: nodeResults.reduce((sum, r) => sum + r.cost, 0),
      totalDuration: nodeResults.reduce((max, r) => Math.max(max, r.duration), 0),
      nodeResults,
    };
  }
}
