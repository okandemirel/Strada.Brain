/**
 * Orchestrator Goal Decomposition — standalone functions for proactive and
 * reactive goal decomposition during agent execution loops.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 */

import type { AgentState } from "./agent-state.js";
import type { Session } from "./orchestrator-session-manager.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import type { GoalTree, GoalNodeId, GoalStatus } from "../goals/types.js";
import type { MonitorLifecycle } from "../dashboard/monitor-lifecycle.js";
import type { SessionManager } from "./orchestrator-session-manager.js";
import type { WorkspaceBus } from "../dashboard/workspace-bus.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import { summarizeTree } from "../goals/goal-renderer.js";
import { formatGoalPlanMarkdown } from "../goals/goal-feedback.js";
import { goalTreeToDagPayload } from "../dashboard/workspace-events.js";
import { getLogger } from "../utils/logger.js";
import { GoalDecompositionProviderError } from "../goals/goal-decomposer.js";
import { getResilienceMessage } from "./resilience-messages.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoalDecompositionDeps {
  readonly goalDecomposer: GoalDecomposer | null;
  readonly activeGoalTrees: Map<string, GoalTree>;
  readonly sessionManager: SessionManager;
  readonly monitorLifecycle: MonitorLifecycle | null;
  readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  readonly workspaceBus: WorkspaceBus | null;
  /** Best-effort goal-tree persistence (v1 parity: the interactive onGoalDecomposed callback
   *  upserted the tree; the helper now owns it so EVERY decomposition path persists). */
  readonly goalStorage: { upsertTree(tree: GoalTree, status: string): void } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emitGoalEvent(
  eventEmitter: IEventEmitter<LearningEventMap> | null,
  rootId: GoalNodeId | string,
  nodeId: GoalNodeId | string,
  status: GoalStatus,
  depth: number,
): void {
  if (!eventEmitter) return;
  eventEmitter.emit("goal:status-changed", {
    rootId: rootId as GoalNodeId,
    nodeId: nodeId as GoalNodeId,
    status,
    depth,
    timestamp: Date.now(),
  });
}

function emitDagEvent(
  workspaceBus: WorkspaceBus | null,
  eventName: "monitor:dag_init" | "monitor:dag_restructure",
  goalTree: GoalTree,
  conversationId?: string,
): void {
  if (!workspaceBus) return;
  workspaceBus.emit(eventName, goalTreeToDagPayload(goalTree, conversationId));
}

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Run proactive goal decomposition if the decomposer is available and the
 * message qualifies. Returns an updated agentState with plan augmented by
 * the goal tree summary. Parse/validation failures are non-fatal (the original
 * agentState is returned unchanged). A genuine provider OUTAGE during
 * decomposition (all providers failed / unresponsive endpoint) is surfaced to
 * the user (system pill / chat notice) + settles the monitor as FAILED, then
 * re-throws so the run terminates cleanly instead of hanging in PENDING.
 */
export async function runProactiveGoalDecomposition(
  deps: GoalDecompositionDeps,
  opts: {
    conversationScope: string;
    userMessage: string;
    chatId: string;
    session: Session;
    agentState: AgentState;
    /** Resolved user language for the outage notice (defaults to "en"). */
    language?: string;
  },
): Promise<AgentState> {
  if (!deps.goalDecomposer || !deps.goalDecomposer.shouldDecompose(opts.userMessage)) {
    return opts.agentState;
  }
  try {
    const goalTree = await deps.goalDecomposer.decomposeProactive(
      opts.conversationScope,
      opts.userMessage,
    );
    deps.activeGoalTrees.set(opts.conversationScope, goalTree);
    emitGoalEvent(deps.eventEmitter, goalTree.rootId, goalTree.rootId, "pending", 0);
    if (deps.monitorLifecycle) {
      deps.monitorLifecycle.goalDecomposed(opts.conversationScope, goalTree);
    } else {
      emitDagEvent(deps.workspaceBus, "monitor:dag_init", goalTree, opts.conversationScope);
    }
    // v1 parity (interactive onGoalDecomposed callback): persist the decomposed tree.
    // Best-effort — DAG display still works via the WS events above.
    try {
      deps.goalStorage?.upsertTree(goalTree, "executing");
    } catch {
      /* goal persistence is best-effort */
    }
    await deps.sessionManager.sendVisibleAssistantMarkdown(
      opts.chatId,
      opts.session,
      formatGoalPlanMarkdown(goalTree, { seedText: opts.userMessage }),
    );
    const treeSummary = summarizeTree(goalTree);
    return {
      ...opts.agentState,
      plan: (opts.agentState.plan ?? "") + "\n\n[Goal Tree: " + treeSummary + "]",
    };
  } catch (decompError) {
    getLogger().warn("Proactive goal decomposition failed", {
      chatId: opts.chatId,
      error: decompError instanceof Error ? decompError.message : String(decompError),
    });
    // A genuine provider outage during decomposition (all providers failed /
    // unresponsive endpoint) must NOT be swallowed into a silent PENDING state.
    // Surface a clear user-facing notice (system pill / chat) AND settle the monitor
    // episode as FAILED so the DAG shows failed (not silent pending), then re-throw
    // the typed error so the run terminates cleanly instead of degrading silently.
    if (decompError instanceof GoalDecompositionProviderError) {
      const notice = getResilienceMessage("provider_abort", opts.language ?? "en");
      try {
        await deps.sessionManager.sendVisibleAssistantNotice(
          opts.chatId,
          opts.session,
          notice,
        );
      } catch (noticeErr) {
        getLogger().warn("Failed to surface goal-decomposition provider-outage notice", {
          chatId: opts.chatId,
          error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        });
      }
      // Settle/clear any pending DAG node for this scope: mark the monitor episode
      // terminal-failed so the monitor renders FAILED, not a hung pending card.
      deps.monitorLifecycle?.requestEnd(opts.conversationScope, true);
      throw decompError;
    }
    return opts.agentState;
  }
}

/**
 * Run reactive goal decomposition when the REFLECTING phase decides to REPLAN.
 * Finds the currently-executing node, marks it failed, and attempts to
 * decompose reactively. Non-fatal: errors are logged and swallowed.
 */
export async function runReactiveGoalDecomposition(
  deps: GoalDecompositionDeps,
  opts: {
    conversationScope: string;
    chatId: string;
    session: Session;
    responseText: string;
  },
): Promise<void> {
  if (!deps.goalDecomposer || !deps.activeGoalTrees.has(opts.conversationScope)) {
    return;
  }
  try {
    const goalTree = deps.activeGoalTrees.get(opts.conversationScope)!;
    // Find the currently-executing node
    let executingNodeId: GoalNodeId | null = null;
    for (const [, node] of goalTree.nodes) {
      if (node.status === "executing") {
        executingNodeId = node.id;
        break;
      }
    }
    if (executingNodeId) {
      const executingNode = goalTree.nodes.get(executingNodeId)!;
      emitGoalEvent(
        deps.eventEmitter,
        goalTree.rootId,
        executingNodeId,
        "failed",
        executingNode.depth,
      );
      const updatedTree = await deps.goalDecomposer.decomposeReactive(
        goalTree,
        executingNodeId,
        opts.responseText,
      );
      if (updatedTree) {
        deps.activeGoalTrees.set(opts.conversationScope, updatedTree);
        if (deps.monitorLifecycle) {
          deps.monitorLifecycle.goalRestructured(opts.conversationScope, updatedTree);
        } else {
          emitDagEvent(deps.workspaceBus, "monitor:dag_restructure", updatedTree, opts.conversationScope);
        }
        await deps.sessionManager.sendVisibleAssistantMarkdown(
          opts.chatId,
          opts.session,
          formatGoalPlanMarkdown(updatedTree, {
            seedText: updatedTree.taskDescription,
            updated: true,
          }),
        );
      } else {
        getLogger().info("Reactive decomposition skipped (depth limit reached)", {
          chatId: opts.chatId,
          nodeId: executingNodeId,
        });
      }
    }
  } catch (reactiveError) {
    // Reactive decomposition failure is non-fatal
    getLogger().warn("Reactive goal decomposition failed", {
      chatId: opts.chatId,
      error:
        reactiveError instanceof Error ? reactiveError.message : String(reactiveError),
    });
  }
}
