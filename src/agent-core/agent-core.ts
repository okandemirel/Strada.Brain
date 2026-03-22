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
import { getLogger } from "../utils/logger.js";
import { ObservationEngine } from "./observation-engine.js";
import { PriorityScorer } from "./priority-scorer.js";
import { buildReasoningPrompt, parseReasoningResponse } from "./reasoning-prompt.js";
import type { AgentCoreConfig, BudgetTrackerRef, InstinctRetrieverRef } from "./agent-core-types.js";
import { DEFAULT_AGENT_CORE_CONFIG } from "./agent-core-types.js";
import type { ProviderRouter } from "./routing/provider-router.js";
import { TaskClassifier } from "./routing/task-classifier.js";

export class AgentCore {
  static readonly AGENT_CHAT_ID = "agent-core";
  static readonly AGENT_CHANNEL_TYPE = "daemon";

  private tickInFlight = false;
  private lastReasoningMs = Date.now(); // Init to now to prevent immediate LLM call on restart
  private readonly config: AgentCoreConfig;
  private readonly logger = getLogger();
  /** Multi-provider routing: selects best provider per task. */
  private readonly providerRouter?: ProviderRouter;
  private readonly taskClassifier = new TaskClassifier();
  /** ProviderManager reference — needed to materialize routing decisions. */
  private readonly providerManagerRef?: { getProviderByName(name: string): IAIProvider | null };

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
   * Observe -> Orient -> Decide -> Act
   */
  async tick(): Promise<void> {
    // Guard: prevent concurrent tick overlap
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      // Rate limit
      if (Date.now() - this.lastReasoningMs < this.config.minReasoningIntervalMs) return;

      // Budget guard
      const budget = this.budgetTracker.getUsage();
      // budget.pct is a 0.0-1.0 decimal fraction from BudgetTracker
      if (budget.pct >= (1.0 - this.config.budgetFloorPct / 100)) {
        this.logger.debug("AgentCore: skipping tick — budget floor reached", { budgetPct: budget.pct });
        return;
      }

      // 1. OBSERVE
      const observations = this.observationEngine.collect();
      if (observations.length === 0) return;

      // 2. ORIENT — score and rank
      const ranked = await this.priorityScorer.scoreAll(observations);
      if (ranked.length === 0 || ranked[0]!.priority < this.config.minObservationPriority) {
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
      if (this.instinctRetriever) {
        try {
          const topSummary = ranked.slice(0, 3).map(o => o.summary).join("; ");
          const result = await this.instinctRetriever.getInsightsForTask(topSummary);
          learnedInsights = result.insights;
          if (learnedInsights.length > 0) {
            this.logger.debug("AgentCore: instinct insights retrieved", {
              count: learnedInsights.length,
              matchedIds: result.matchedInstinctIds.length,
            });
          }
        } catch {
          // Non-fatal — continue without insights
        }
      }

      // Get active task count for context
      let activeTaskCount = 0;
      try {
        const tasks = this.taskManager.listTasks(AgentCore.AGENT_CHAT_ID);
        activeTaskCount = tasks.filter(t => t.status === "executing" || t.status === "pending").length;
      } catch {
        // Non-fatal
      }

      const prompt = buildReasoningPrompt({
        observations: ranked,
        budgetRemainingPct: Math.max(0, Math.round((1.0 - budget.pct) * 100)),
        activeTaskCount,
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
            await this.taskManager.submit(
              AgentCore.AGENT_CHAT_ID,
              AgentCore.AGENT_CHANNEL_TYPE,
              decision.goal,
              { origin: "daemon" as const },
            );
            // Record action for dedup
            if (ranked[0]) this.priorityScorer.recordAction(ranked[0]);
            this.logger.info("AgentCore: submitted goal", { goal: decision.goal.slice(0, 200) });
          }
          break;

        case "notify":
          if (decision.message) {
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
            try {
              await this.channel.sendText(AgentCore.AGENT_CHAT_ID, `[Agent needs input] ${decision.question}`);
            } catch {
              this.logger.debug("AgentCore: no channel for escalation");
            }
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

  /** Stop the observation engine and clean up resources */
  stop(): void {
    this.observationEngine.stop();
  }
}
