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
} from "./supervisor-types.js";
import type { CapabilityMatcher } from "./capability-matcher.js";
import type { ProviderAssigner } from "./provider-assigner.js";
import { SupervisorDispatcher } from "./supervisor-dispatcher.js";
import { ResultAggregator } from "./result-aggregator.js";

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
  readonly eventEmitter?: { emit: (event: string, payload: any) => void };
}

// =============================================================================
// SUPERVISOR BRAIN
// =============================================================================

export class SupervisorBrain {
  private readonly config: SupervisorConfig;
  private readonly decomposer: SupervisorDecomposer;
  private readonly capabilityMatcher: CapabilityMatcher;
  private readonly providerAssigner: ProviderAssigner;
  private readonly emitter?: { emit: (event: string, payload: any) => void };

  private executeNodeFn?: (node: TaggedGoalNode, context: SupervisorContext) => Promise<NodeResult>;

  constructor(options: SupervisorBrainOptions) {
    this.config = options.config;
    this.decomposer = options.decomposer;
    this.capabilityMatcher = options.capabilityMatcher;
    this.providerAssigner = options.providerAssigner;
    this.emitter = options.eventEmitter;
  }

  // ---------------------------------------------------------------------------
  // LAZY SETTER (bootstrap circular dependency resolution)
  // ---------------------------------------------------------------------------

  /**
   * Set the executeNode callback used to run individual goal nodes.
   * Must be called before execute() or execute() will throw.
   */
  setExecuteNode(
    fn: (node: TaggedGoalNode, context: SupervisorContext) => Promise<NodeResult>,
  ): void {
    this.executeNodeFn = fn;
  }

  // ---------------------------------------------------------------------------
  // ABORT
  // ---------------------------------------------------------------------------

  private abortController = new AbortController();

  /** Abort all active work. */
  abort(): void {
    this.abortController.abort();
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
    // Step 1: Check if decomposition is warranted
    if (!this.decomposer.shouldDecompose(task)) {
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
    const internalSignal = this.abortController.signal;

    try {
      // Step 2: Emit supervisor:activated
      this.emitter?.emit("supervisor:activated", {
        taskId: context.chatId,
        complexity: this.config.complexityThreshold,
        nodeCount: 0, // updated after decomposition
      });

      // Step 3: Decompose the task into a GoalTree
      const goalTree = await this.decomposer.decomposeProactive(
        context.chatId,
        task,
      );

      // Check abort after decomposition
      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult([], "Aborted after decomposition");
      }

      // Step 4: Extract leaf nodes (non-root nodes)
      const MAX_SUPERVISOR_NODES = 50;
      const leafNodes = this.extractLeafNodes(goalTree);

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

      // Step 7: Emit supervisor:plan_ready
      const assignments: Record<string, { provider: string; model: string }> = {};
      for (const node of assignedNodes) {
        assignments[node.id] = {
          provider: node.assignedProvider ?? "unassigned",
          model: node.assignedModel ?? "unknown",
        };
      }
      this.emitter?.emit("supervisor:plan_ready", {
        dag: { rootId: goalTree.rootId, nodeCount: assignedNodes.length },
        assignments,
      });

      // Check abort after assignment
      if (externalSignal?.aborted || internalSignal.aborted) {
        return this.makePartialResult([], "Aborted after provider assignment");
      }

      // Step 8: Create dispatcher and dispatch
      const executeNodeFn = this.executeNodeFn;
      const dispatcher = new SupervisorDispatcher({
        executeNode: (node: TaggedGoalNode) => executeNodeFn(node, context),
        config: {
          maxParallelNodes: this.config.maxParallelNodes,
          nodeTimeoutMs: this.config.nodeTimeoutMs,
          maxFailureBudget: this.config.maxFailureBudget,
        },
        eventEmitter: this.emitter,
      });

      // Combine signals: use external signal if provided, otherwise internal
      const dispatchSignal = externalSignal ?? internalSignal;
      const results = await dispatcher.dispatch(assignedNodes, dispatchSignal);

      // Step 10-12: Create aggregator, verify, and synthesize
      const aggregator = new ResultAggregator({
        mode: this.config.verificationMode,
        samplingRate: this.config.verificationBudgetPct / 100,
        preferDifferentProvider: true,
        maxVerificationCost: 0,
      });

      const verifiedResults = await aggregator.verify(results);
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

      return supervisorResult;
    } catch (err: unknown) {
      const { getLogger } = await import("../utils/logger.js");
      const logger = getLogger?.();
      logger?.warn("Supervisor pipeline error", { error: err instanceof Error ? err.message : String(err) });
      return this.makePartialResult([], "An error occurred during task execution. Please try again.");
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
