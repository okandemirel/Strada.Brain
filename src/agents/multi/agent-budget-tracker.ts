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

import { randomUUID } from "node:crypto";
import { getLoggerSafe } from "../../utils/logger.js";
import type { DaemonStorage } from "../../daemon/daemon-storage.js";
import type { BudgetUsage } from "../../daemon/budget/budget-tracker.js";
import type { AgentId } from "./agent-types.js";

/** 24 hours in milliseconds (same as BudgetTracker) */
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A reservation older than this is treated as leaked and dropped when the
 * reserved total is read. Nothing this tracker guards runs for an hour, and a
 * reservation that outlives its work would quietly shrink the agent's cap
 * forever — a silent cap is exactly what the ledger must not become. The drop
 * is logged, never silent.
 */
const RESERVATION_MAX_AGE_MS = 60 * 60 * 1000;

/** An in-flight commitment against an agent's cap that has not been spent yet. */
interface BudgetReservation {
  readonly agentId: AgentId;
  /** Pessimistic up-front estimate of what the reserved work may cost. */
  readonly estimateUsd: number;
  /** Real cost already recorded against this reservation (shrinks it). */
  chargedUsd: number;
  readonly createdAt: number;
}

export class AgentBudgetTracker {
  private readonly storage: DaemonStorage;
  /**
   * Outstanding reservations, keyed by reservation id. In-memory by design:
   * a reservation only means "work is in flight in THIS process", and a
   * process that died has no in-flight work to hold headroom for.
   */
  private readonly reservations = new Map<string, BudgetReservation>();

  constructor(storage: DaemonStorage) {
    this.storage = storage;
  }

  /**
   * Apply migration for agent_id column support.
   * Must be called after construction, before any budget operations.
   */
  initialize(): void {
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
      /**
       * Charge this cost against an outstanding reservation, shrinking the
       * headroom it still holds. Without it a running delegation would be
       * counted twice — once as spend, once as its own untouched estimate.
       */
      reservationId?: string;
    },
  ): void {
    if (opts?.reservationId) {
      const reservation = this.reservations.get(opts.reservationId);
      if (reservation) reservation.chargedUsd += costUsd;
    }
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
    return toBudgetUsage(usedUsd, capUsd);
  }

  /**
   * Get global budget usage across all agents + legacy entries (null agent_id)
   * within the rolling 24h window.
   */
  getGlobalUsage(globalCapUsd?: number): BudgetUsage {
    const windowStart = Date.now() - ROLLING_WINDOW_MS;
    const usedUsd = this.storage.sumBudgetSince(windowStart);
    return toBudgetUsage(usedUsd, globalCapUsd);
  }

  // ===========================================================================
  // RESERVATIONS
  //
  // A budget gate that reads the recorded total and then spawns is check-then-act:
  // N concurrent delegations all read the SAME pre-spawn total (nothing is charged
  // until a sub-agent settles), so a parent at 95% of its cap passed the check N
  // times and could breach the cap N times over. A reservation makes the in-flight
  // work visible to the next caller's check (audited 2026-09-02).
  // ===========================================================================

  /**
   * Reserve a pessimistic estimate against an agent's cap for work about to start.
   * Returns the reservation id; the caller MUST settle() or release() it.
   * A non-positive estimate reserves nothing but still returns an id, so callers
   * keep one unconditional release path.
   */
  reserve(agentId: AgentId, estimateUsd: number): string {
    const id = randomUUID();
    this.reservations.set(id, {
      agentId,
      estimateUsd: estimateUsd > 0 ? estimateUsd : 0,
      chargedUsd: 0,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * Drop a reservation without charging anything. Idempotent, and safe for a
   * reservation that was already settled — it covers the paths where the
   * reserved work never ran or threw before it could report a cost.
   */
  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /**
   * Settle a reservation: replace it with the run's real cost and drop it.
   * Costs already streamed in via recordCost({ reservationId }) are subtracted,
   * so settling never double-charges what was billed while the work ran.
   * Settling an unknown id records the full cost — the money was still spent.
   * agentId is passed explicitly (not read off the reservation) so the charge
   * lands on the payer even when the reservation is already gone.
   */
  settle(
    reservationId: string,
    agentId: AgentId,
    costUsd: number,
    opts?: {
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      triggerName?: string;
    },
  ): void {
    const reservation = this.reservations.get(reservationId);
    this.reservations.delete(reservationId);
    const unbilled = costUsd - (reservation?.chargedUsd ?? 0);
    if (unbilled > 0) {
      this.recordCost(agentId, unbilled, opts);
    }
  }

  /**
   * Total still reserved (estimate minus what has already been billed) for an
   * agent's in-flight work. Reservations past RESERVATION_MAX_AGE_MS are dropped
   * as leaked, with a warning naming how many — never silently.
   */
  getAgentReservedUsd(agentId: AgentId): number {
    const now = Date.now();
    let leaked = 0;
    let reservedUsd = 0;
    for (const [id, reservation] of this.reservations) {
      if (now - reservation.createdAt > RESERVATION_MAX_AGE_MS) {
        this.reservations.delete(id);
        leaked++;
        continue;
      }
      if (reservation.agentId !== agentId) continue;
      reservedUsd += Math.max(0, reservation.estimateUsd - reservation.chargedUsd);
    }
    if (leaked > 0) {
      getLoggerSafe().warn("Dropped leaked agent budget reservations older than the reservation ceiling", {
        leaked,
        maxAgeMs: RESERVATION_MAX_AGE_MS,
      });
    }
    return reservedUsd;
  }

  /**
   * What the agent has COMMITTED against its cap: recorded spend plus the
   * unbilled remainder of its in-flight reservations. The two are reported
   * separately so a caller never presents a reservation as money spent.
   */
  getAgentCommitment(
    agentId: AgentId,
    capUsd?: number,
  ): { usedUsd: number; reservedUsd: number; committedUsd: number; limitUsd?: number } {
    const usedUsd = this.getAgentUsage(agentId, capUsd).usedUsd;
    const reservedUsd = this.getAgentReservedUsd(agentId);
    return { usedUsd, reservedUsd, committedUsd: usedUsd + reservedUsd, limitUsd: capUsd };
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

/** Build a BudgetUsage object from used amount and optional cap */
function toBudgetUsage(usedUsd: number, limitUsd?: number): BudgetUsage {
  const pct = limitUsd !== undefined && limitUsd > 0 ? usedUsd / limitUsd : 0;
  return { usedUsd, limitUsd, pct };
}
