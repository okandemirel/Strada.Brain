/**
 * Agent Budget Tracker
 *
 * Per-agent budget tracking with hierarchical rollup to global usage.
 * Wraps DaemonStorage budget methods with agent_id awareness.
 *
 * - recordCost() stores entries with agent_id for per-agent isolation
 * - getAgentUsage() returns only that agent's costs
 * - getGlobalUsage() returns all agents + legacy (null agent_id) entries
 * - isAgentExceeded() checks per-agent cap enforcement
 *
 * Uses the same 24h rolling window as BudgetTracker.
 *
 * Requirements: AGENT-07 (per-agent budget caps)
 */

import type { DaemonStorage } from "../../daemon/daemon-storage.js";
import type { BudgetUsage } from "../../daemon/budget/budget-tracker.js";
import type { AgentId } from "./agent-types.js";

/** 24 hours in milliseconds (same as BudgetTracker) */
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export class AgentBudgetTracker {
  private readonly storage: DaemonStorage;

  constructor(storage: DaemonStorage) {
    this.storage = storage;
    // Apply migration for agent_id column support
    this.storage.migrateAgentBudget();
  }

  /**
   * Record an LLM cost entry for a specific agent.
   */
  recordCost(
    agentId: AgentId,
    costUsd: number,
    opts?: {
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      triggerName?: string;
    },
  ): void {
    this.storage.insertBudgetEntryWithAgent({
      costUsd,
      model: opts?.model,
      tokensIn: opts?.tokensIn,
      tokensOut: opts?.tokensOut,
      triggerName: opts?.triggerName,
      timestamp: Date.now(),
      agentId,
    });
  }

  /**
   * Get budget usage for a specific agent within the rolling 24h window.
   */
  getAgentUsage(agentId: AgentId, capUsd?: number): BudgetUsage {
    const windowStart = Date.now() - ROLLING_WINDOW_MS;
    const usedUsd = this.storage.sumBudgetSinceForAgent(windowStart, agentId);
    const limitUsd = capUsd;
    const pct = limitUsd !== undefined && limitUsd > 0 ? usedUsd / limitUsd : 0;
    return { usedUsd, limitUsd, pct };
  }

  /**
   * Get global budget usage across all agents + legacy entries (null agent_id)
   * within the rolling 24h window.
   */
  getGlobalUsage(globalCapUsd?: number): BudgetUsage {
    const windowStart = Date.now() - ROLLING_WINDOW_MS;
    // sumBudgetSince sums ALL entries regardless of agent_id
    const usedUsd = this.storage.sumBudgetSince(windowStart);
    const limitUsd = globalCapUsd;
    const pct = limitUsd !== undefined && limitUsd > 0 ? usedUsd / limitUsd : 0;
    return { usedUsd, limitUsd, pct };
  }

  /**
   * Check if a specific agent has exceeded its budget cap.
   * Returns true when agent usage >= capUsd.
   */
  isAgentExceeded(agentId: AgentId, capUsd: number): boolean {
    const usage = this.getAgentUsage(agentId, capUsd);
    return usage.pct >= 1.0;
  }

  /**
   * Get per-agent usage totals for dashboard display.
   * Returns a map of agentId -> usedUsd within the rolling 24h window.
   */
  getAllAgentUsages(): Map<AgentId, number> {
    const windowStart = Date.now() - ROLLING_WINDOW_MS;
    const raw = this.storage.sumBudgetGroupByAgent(windowStart);
    const result = new Map<AgentId, number>();
    for (const [agentId, total] of raw) {
      result.set(agentId as AgentId, total);
    }
    return result;
  }
}
