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
import type { AgentCoreConfig } from "./agent-core-types.js";
import { DEFAULT_AGENT_CORE_CONFIG } from "./agent-core-types.js";

/** Structural interface for BudgetTracker */
interface BudgetTrackerRef {
  getUsage(cap?: number): { usedUsd: number; limitUsd: number | undefined; pct: number };
}

/** Structural interface for InstinctRetriever */
interface InstinctRetrieverRef {
  getInsightsForTask(taskDescription: string): Promise<{ insights: string[]; matchedInstinctIds: string[] }>;
}

export class AgentCore {
  static readonly AGENT_CHAT_ID = "agent-core";
  static readonly AGENT_CHANNEL_TYPE = "daemon";

  private tickInFlight = false;
  private lastReasoningMs = 0;
  private readonly config: AgentCoreConfig;
  private readonly logger = getLogger();

  constructor(
    private readonly observationEngine: ObservationEngine,
    private readonly priorityScorer: PriorityScorer,
    private readonly provider: IAIProvider,
    private readonly taskManager: TaskManager,
    private readonly channel: IChannelAdapter,
    private readonly budgetTracker: BudgetTrackerRef,
    private readonly instinctRetriever?: InstinctRetrieverRef,
    config?: Partial<AgentCoreConfig>,
  ) {
    this.config = { ...DEFAULT_AGENT_CORE_CONFIG, ...config };
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
      if (budget.pct >= (100 - this.config.budgetFloorPct)) {
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

      // Gather context
      let learnedInsights: string[] = [];
      if (this.instinctRetriever) {
        try {
          const topSummary = ranked.slice(0, 3).map(o => o.summary).join("; ");
          const result = await this.instinctRetriever.getInsightsForTask(topSummary);
          learnedInsights = result.insights;
        } catch {
          // Non-fatal
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
        budgetRemainingPct: Math.max(0, 100 - (budget.pct ?? 0)),
        activeTaskCount,
        learnedInsights,
        recentHistory: this.observationEngine.getHistory(5),
      });

      const response = await this.provider.chat(prompt, [], []);
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
}
