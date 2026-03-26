/**
 * Agent Core
 *
 * The autonomous reasoning engine. Runs as part of HeartbeatLoop.tick().
 * Observes environment -> scores priorities -> reasons with LLM -> acts.
 *
 * Safety: tickInFlight guard, rate limiting, budget floor, priority threshold.
 */

import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { getLogger } from "../utils/logger.js";
import { ObservationEngine } from "./observation-engine.js";
import { createObservation, type AgentObservation } from "./observation-types.js";
import { PriorityScorer } from "./priority-scorer.js";
import { buildReasoningPrompt, parseReasoningResponse } from "./reasoning-prompt.js";
import type { ActionDecision, AgentCoreConfig, BudgetTrackerRef, InstinctRetrieverRef } from "./agent-core-types.js";
import { DEFAULT_AGENT_CORE_CONFIG } from "./agent-core-types.js";
import type { ProviderRouter } from "./routing/provider-router.js";
import { TaskClassifier } from "./routing/task-classifier.js";

const FOREGROUND_DECISION_DEFER_MINUTES = 5;

export class AgentCore {
  static readonly AGENT_CHAT_ID = "agent-core";
  static readonly AGENT_CHANNEL_TYPE = "daemon";

  private tickInFlight = false;
  private lastReasoningMs = Date.now(); // Init to now to prevent immediate LLM call on restart
  private readonly config: AgentCoreConfig;
  private readonly logger = getLogger();
  /** Maps submitted task IDs to the instinct IDs that informed the decision */
  private readonly taskInstinctMap = new Map<TaskId, { instinctIds: string[]; createdAt: number }>();
  /** Multi-provider routing: selects best provider per task. */
  private readonly providerRouter?: ProviderRouter;
  private readonly taskClassifier = new TaskClassifier();
  /** ProviderManager reference — needed to materialize routing decisions. */
  private readonly providerManagerRef?: { getProviderByName(name: string): IAIProvider | null };
  /** Runtime overrides set by the 'adjust' action */
  private runtimeOverrides: { priorityThreshold?: number; sourceBoosts: Map<string, number>; reasoningIntervalMs?: number } = { sourceBoosts: new Map() };

  constructor(
    private readonly observationEngine: ObservationEngine,
    private readonly priorityScorer: PriorityScorer,
    private readonly provider: IAIProvider,
    private readonly taskManager: TaskManager,
    private readonly channel: IChannelAdapter,
    private readonly budgetTracker: BudgetTrackerRef,
    private readonly instinctRetriever?: InstinctRetrieverRef,
    config?: Partial<AgentCoreConfig>,
    providerRouter?: ProviderRouter,
    providerManagerRef?: { getProviderByName(name: string): IAIProvider | null },
  ) {
    this.config = { ...DEFAULT_AGENT_CORE_CONFIG, ...config };
    this.providerRouter = providerRouter;
    this.providerManagerRef = providerManagerRef;
  }

  /**
   * Main agent tick — called from HeartbeatLoop.
   * Maintenance (outcome check) -> Observe -> Orient -> Decide -> Act
   */
  async tick(): Promise<void> {
    // Guard: prevent concurrent tick overlap
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      // Rate limit (respect runtime override if set)
      const effectiveIntervalMs = this.runtimeOverrides.reasoningIntervalMs ?? this.config.minReasoningIntervalMs;
      if (Date.now() - this.lastReasoningMs < effectiveIntervalMs) return;

      // Budget guard
      const budget = this.budgetTracker.getUsage();
      // budget.pct is a 0.0-1.0 decimal fraction from BudgetTracker
      if (budget.pct >= (1.0 - this.config.budgetFloorPct / 100)) {
        this.logger.debug("AgentCore: skipping tick — budget floor reached", { budgetPct: budget.pct });
        return;
      }

      // Check for completed tasks and inject outcome observations
      this.checkCompletedTasks();

      // 1. OBSERVE
      const observations = this.observationEngine.collect();
      if (observations.length === 0) return;

      // 2. ORIENT — score and rank
      const ranked = await this.priorityScorer.scoreAll(observations);

      // Apply runtime source boosts in-place
      for (const obs of ranked) {
        const boost = this.runtimeOverrides.sourceBoosts.get(obs.source);
        if (boost) {
          (obs as { priority: number }).priority = Math.min(100, Math.max(0, obs.priority + boost));
        }
      }
      // Re-sort after boosts
      if (this.runtimeOverrides.sourceBoosts.size > 0) {
        ranked.sort((a, b) => b.priority - a.priority);
      }

      const effectivePriorityThreshold = this.runtimeOverrides.priorityThreshold ?? this.config.minObservationPriority;
      if (ranked.length === 0 || ranked[0]!.priority < effectivePriorityThreshold) {
        this.logger.debug("AgentCore: skipping tick — no high-priority observations", {
          count: ranked.length,
          topPriority: ranked[0]?.priority ?? 0,
        });
        return;
      }

      // 3. DECIDE — LLM reasoning
      this.lastReasoningMs = Date.now();

      // Gather context — instinct insights are confidence-ranked by the retriever
      let learnedInsights: string[] = [];
      let matchedInstinctIds: string[] = [];
      if (this.instinctRetriever) {
        try {
          const topSummary = ranked.slice(0, 3).map(o => o.summary).join("; ");
          const result = await this.instinctRetriever.getInsightsForTask(topSummary);
          learnedInsights = result.insights;
          matchedInstinctIds = result.matchedInstinctIds;
          if (learnedInsights.length > 0) {
            this.logger.debug("AgentCore: instinct insights retrieved", {
              count: learnedInsights.length,
              matchedIds: matchedInstinctIds.length,
            });
          }
        } catch {
          // Non-fatal — continue without insights
        }
      }

      // Get active task count for context
      let activeTaskCount = 0;
      let activeForegroundTaskCount = 0;
      try {
        const tasks = this.taskManager.listTasks(AgentCore.AGENT_CHAT_ID);
        activeTaskCount = tasks.filter(t => t.status === "executing" || t.status === "pending").length;
        activeForegroundTaskCount = this.taskManager.countActiveForegroundTasks?.([AgentCore.AGENT_CHAT_ID]) ?? 0;
      } catch {
        // Non-fatal
      }

      const prompt = buildReasoningPrompt({
        observations: ranked,
        budgetRemainingPct: Math.max(0, Math.round((1.0 - budget.pct) * 100)),
        activeTaskCount,
        activeForegroundTaskCount,
        learnedInsights,
        recentHistory: this.observationEngine.getHistory(5),
      });

      // Task-aware provider routing
      let activeProvider: IAIProvider = this.provider;
      if (this.providerRouter && this.providerManagerRef && ranked.length > 0) {
        try {
          const taskClass = this.taskClassifier.classify(ranked[0]!.summary);
          const routed = this.providerRouter.resolve(taskClass);
          if (routed) {
            const resolved = this.providerManagerRef.getProviderByName(routed.provider);
            if (resolved) activeProvider = resolved;
          }
        } catch {
          // Non-fatal — use default provider
        }
      }

      // Reasoning prompt goes as user message, not system prompt
      const response = await activeProvider.chat(
        "You are an autonomous agent that observes the environment and decides what to do.",
        [{ role: "user" as const, content: prompt }],
        [],
      );
      const decision = parseReasoningResponse(response.text);

      this.logger.info("AgentCore decision", {
        action: decision.action,
        reasoning: decision.reasoning.slice(0, 200),
        observationCount: ranked.length,
        topObservation: ranked[0]?.summary.slice(0, 100),
      });

      // 4. ACT
      switch (decision.action) {
        case "execute":
          if (decision.goal) {
            const task = this.taskManager.submit(
              AgentCore.AGENT_CHAT_ID,
              AgentCore.AGENT_CHANNEL_TYPE,
              decision.goal,
              { origin: "daemon" as const },
            );
            if (matchedInstinctIds.length > 0) {
              this.taskInstinctMap.set(task.id, { instinctIds: matchedInstinctIds, createdAt: Date.now() });
            }
            // Record action for dedup
            if (ranked[0]) this.priorityScorer.recordAction(ranked[0]);
            this.logger.info("AgentCore: submitted goal", { goal: decision.goal.slice(0, 200) });
          }
          break;

        case "notify":
          if (decision.message) {
            if (this.deferHumanVisibleDecision(decision, ranked[0], activeForegroundTaskCount)) {
              break;
            }
            // Find any connected user channel to notify
            try {
              await this.channel.sendText(AgentCore.AGENT_CHAT_ID, decision.message);
            } catch {
              this.logger.debug("AgentCore: no channel for notification");
            }
          }
          break;

        case "escalate":
          if (decision.question) {
            if (this.deferHumanVisibleDecision(decision, ranked[0], activeForegroundTaskCount)) {
              break;
            }
            try {
              await this.channel.sendText(AgentCore.AGENT_CHAT_ID, `[Agent needs input] ${decision.question}`);
            } catch {
              this.logger.debug("AgentCore: no channel for escalation");
            }
          }
          break;

        case "batch":
          if (decision.batchObservationIds && decision.batchObservationIds.length > 0 && decision.goal) {
            const idSet = new Set(decision.batchObservationIds);
            const matched = ranked.filter(o => idSet.has(o.id));
            const batchContext = matched.map(o => `[${o.source}] ${o.summary}`).join("; ");
            const compoundGoal = `${decision.goal} (context: ${batchContext})`;
            const task = this.taskManager.submit(
              AgentCore.AGENT_CHAT_ID,
              AgentCore.AGENT_CHANNEL_TYPE,
              compoundGoal,
              { origin: "daemon" as const },
            );
            if (matchedInstinctIds.length > 0) {
              this.taskInstinctMap.set(task.id, { instinctIds: matchedInstinctIds, createdAt: Date.now() });
            }
            for (const obs of matched) this.priorityScorer.recordAction(obs);
            this.logger.info("AgentCore: submitted batch goal", { goal: compoundGoal.slice(0, 200), batchSize: matched.length });
          }
          break;

        case "defer":
          if (ranked[0] && decision.deferMinutes) {
            this.observationEngine.defer(ranked[0], decision.deferMinutes);
            this.logger.info("AgentCore: deferred observation", { id: ranked[0].id, minutes: decision.deferMinutes });
          }
          break;

        case "adjust":
          if (decision.adjustments) {
            if (decision.adjustments.priorityThreshold !== undefined) {
              this.runtimeOverrides.priorityThreshold = decision.adjustments.priorityThreshold;
            }
            if (decision.adjustments.sourceBoost) {
              this.runtimeOverrides.sourceBoosts.set(
                decision.adjustments.sourceBoost.source,
                decision.adjustments.sourceBoost.delta,
              );
            }
            if (decision.adjustments.reasoningIntervalMs !== undefined) {
              this.runtimeOverrides.reasoningIntervalMs = decision.adjustments.reasoningIntervalMs;
            }
            this.logger.info("AgentCore: adjusted runtime overrides", { adjustments: decision.adjustments });
          }
          break;

        case "wait":
          // Intentionally idle
          break;
      }
    } catch (error) {
      this.logger.error("AgentCore tick error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Check if a tick is currently in progress */
  isTickInFlight(): boolean {
    return this.tickInFlight;
  }

  private deferHumanVisibleDecision(
    decision: Pick<ActionDecision, "action">,
    observation: AgentObservation | undefined,
    activeForegroundTaskCount: number,
  ): boolean {
    if (activeForegroundTaskCount <= 0) {
      return false;
    }

    if (observation) {
      this.observationEngine.defer(observation, FOREGROUND_DECISION_DEFER_MINUTES);
    }

    this.logger.info("AgentCore: deferred human-visible decision during foreground task", {
      action: decision.action,
      activeForegroundTaskCount,
      observationSource: observation?.source,
      topObservation: observation?.summary.slice(0, 120),
      deferMinutes: observation ? FOREGROUND_DECISION_DEFER_MINUTES : 0,
    });
    return true;
  }

  /** Check tracked tasks for completion and inject outcome observations. */
  private checkCompletedTasks(): void {
    const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    for (const [taskId, entry] of this.taskInstinctMap.entries()) {
      // TTL cleanup: remove stale entries that never completed
      if (now - entry.createdAt > TTL_MS) {
        this.taskInstinctMap.delete(taskId);
        continue;
      }

      const task = this.taskManager.getStatus(taskId);
      if (!task) continue; // Task not found in storage — skip, don't penalize instincts

      if (task.status === "completed" || task.status === "failed" || task.status === "blocked" || task.status === "cancelled") {
        const success = task.status === "completed";

        this.observationEngine.inject(
          createObservation("task-outcome", `Agent task ${success ? "succeeded" : "failed"}: ${task.title ?? taskId}`, {
            priority: success ? 40 : 70,
            context: { taskId, success },
          }),
        );

        import("../learning/learning-metrics.js").then(({ LearningMetrics }) => {
          LearningMetrics.getInstance().recordOutcome({ success, instinctCount: entry.instinctIds.length });
        }).catch(() => { /* non-fatal */ });

        if (this.instinctRetriever?.recordOutcome) {
          for (const id of entry.instinctIds) {
            this.instinctRetriever.recordOutcome(id, success).catch(() => {});
          }
        }

        this.taskInstinctMap.delete(taskId);
      }
    }
  }

  /** Get current runtime overrides (for testing/diagnostics) */
  getRuntimeOverrides(): { priorityThreshold?: number; sourceBoosts: Map<string, number>; reasoningIntervalMs?: number } {
    return this.runtimeOverrides;
  }

  /** Stop the observation engine and clean up resources */
  stop(): void {
    this.observationEngine.stop();
  }
}
