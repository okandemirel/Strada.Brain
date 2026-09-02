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
/**
 * audited 2026-09-02: ObservationEngine.collect() is destructive (it drains injections and
 * advances every one-shot observer's latch), so a tick that collects and then aborts before
 * acting would lose the batch for good — a broken build reported once stayed unreported until
 * the build turned green and broke again. An unacted batch is re-queued via defer(); one
 * minute clears the engine's 60s dedup window so the re-queued item is not suppressed.
 */
const UNACTED_BATCH_RECHECK_MINUTES = 1;
/**
 * audited 2026-09-02: the `adjust` action wrote priorityThreshold straight from LLM output
 * (clamped only to 0-100) with no ceiling and no way back except another `adjust` — one
 * turn could silence every observation below 100 for the life of the process, and each
 * silenced batch was drained and destroyed. The override is now capped below the score of a
 * failed task outcome (70 + 5 severity + 5 actionable = 80), expires, and a dropped
 * actionable batch is deferred so it is re-evaluated once the threshold has relaxed.
 */
const LLM_PRIORITY_THRESHOLD_CEILING = 80;
const PRIORITY_THRESHOLD_OVERRIDE_TTL_MS = 30 * 60_000;
const BELOW_THRESHOLD_RECHECK_MINUTES = 5;

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
  private runtimeOverrides: {
    priorityThreshold?: number;
    /** When the LLM-set priorityThreshold lapses back to config.minObservationPriority. */
    priorityThresholdExpiresAt?: number;
    sourceBoosts: Map<string, number>;
    reasoningIntervalMs?: number;
  } = { sourceBoosts: new Map() };

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

    // The collected batch, hoisted so the catch can put it back if no ACT arm consumed it.
    let batch: AgentObservation[] = [];
    let consumed = false;
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
      batch = observations;

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

      const effectivePriorityThreshold = this.effectivePriorityThreshold();
      if (ranked.length === 0 || ranked[0]!.priority < effectivePriorityThreshold) {
        this.logger.debug("AgentCore: skipping tick — no high-priority observations", {
          count: ranked.length,
          topPriority: ranked[0]?.priority ?? 0,
          threshold: effectivePriorityThreshold,
        });
        // The batch was drained from one-shot observers. What the LLM-raised threshold silenced
        // (would have passed the configured threshold) is kept for a look once the override lapses;
        // what falls below the configured threshold is the steady state and is not re-queued.
        const silencedByOverride = ranked.filter((o) => o.priority >= this.config.minObservationPriority);
        if (silencedByOverride.length > 0) {
          this.requeueUnacted(silencedByOverride, "below-llm-threshold", BELOW_THRESHOLD_RECHECK_MINUTES);
        }
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
            // audited 2026-09-02: tracking was gated on `matchedInstinctIds.length > 0`, so a goal
            // that matched no instinct (every goal at cold start, and with no retriever wired) was
            // never followed up — its failure produced no task-outcome observation. Every submitted
            // task is tracked; an empty instinctIds list makes the instinct-credit loop a no-op.
            this.taskInstinctMap.set(task.id, { instinctIds: matchedInstinctIds, createdAt: Date.now() });
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
            // audited 2026-09-02: same unconditional tracking as the execute arm (see above).
            this.taskInstinctMap.set(task.id, { instinctIds: matchedInstinctIds, createdAt: Date.now() });
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
              const requested = decision.adjustments.priorityThreshold;
              const applied = Math.min(requested, LLM_PRIORITY_THRESHOLD_CEILING);
              this.runtimeOverrides.priorityThreshold = applied;
              this.runtimeOverrides.priorityThresholdExpiresAt = Date.now() + PRIORITY_THRESHOLD_OVERRIDE_TTL_MS;
              if (applied !== requested) {
                this.logger.info("AgentCore: priorityThreshold override clamped", {
                  requested,
                  applied,
                  ceiling: LLM_PRIORITY_THRESHOLD_CEILING,
                  expiresInMinutes: PRIORITY_THRESHOLD_OVERRIDE_TTL_MS / 60_000,
                });
              }
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
      // Every ACT arm above ran to completion on this batch (an LLM "wait" is a decision too).
      consumed = true;
    } catch (error) {
      this.logger.error("AgentCore tick error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!consumed && batch.length > 0) {
        this.requeueUnacted(batch, "tick-error", UNACTED_BATCH_RECHECK_MINUTES);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Check if a tick is currently in progress */
  isTickInFlight(): boolean {
    return this.tickInFlight;
  }

  /** The LLM-set threshold while it lasts; config.minObservationPriority once it has expired. */
  private effectivePriorityThreshold(): number {
    const { priorityThreshold, priorityThresholdExpiresAt } = this.runtimeOverrides;
    if (priorityThreshold === undefined) return this.config.minObservationPriority;
    if (priorityThresholdExpiresAt !== undefined && Date.now() >= priorityThresholdExpiresAt) {
      this.logger.info("AgentCore: priorityThreshold override expired", {
        was: priorityThreshold,
        now: this.config.minObservationPriority,
      });
      delete this.runtimeOverrides.priorityThreshold;
      delete this.runtimeOverrides.priorityThresholdExpiresAt;
      return this.config.minObservationPriority;
    }
    return priorityThreshold;
  }

  /**
   * Put a batch that no ACT arm consumed back into the engine. Only actionable observations are
   * re-queued (informational ones — "Build succeeded", user idle — carry nothing to act on).
   * Deferred, not injected: defer() re-surfaces past the engine's dedup window, whereas inject()
   * would be suppressed as a duplicate on the very next collect.
   */
  private requeueUnacted(batch: readonly AgentObservation[], cause: string, recheckMinutes: number): void {
    const actionable = batch.filter((o) => o.actionable);
    for (const obs of actionable) {
      this.observationEngine.defer(obs, recheckMinutes);
    }
    this.logger.info("AgentCore: re-queued unacted observations", {
      cause,
      requeued: actionable.length,
      dropped: batch.length - actionable.length,
      recheckMinutes,
      topObservation: batch[0]?.summary.slice(0, 120),
    });
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
            this.instinctRetriever.recordOutcome(id, success).catch((err) => {
              getLogger().debug("Instinct outcome recording failed", { error: err instanceof Error ? err.message : String(err) });
            });
          }
        }

        this.taskInstinctMap.delete(taskId);
      }
    }
  }

  /** Get current runtime overrides (for testing/diagnostics) */
  getRuntimeOverrides(): {
    priorityThreshold?: number;
    priorityThresholdExpiresAt?: number;
    sourceBoosts: Map<string, number>;
    reasoningIntervalMs?: number;
  } {
    return this.runtimeOverrides;
  }

  /** Stop the observation engine and clean up resources */
  stop(): void {
    this.observationEngine.stop();
  }
}
