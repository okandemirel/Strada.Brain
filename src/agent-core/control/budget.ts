/**
 * Agent Core v2 — Control Plane: Budget (ARCHITECTURE §2.3).
 *
 * Pure resource accounting (distinct from wall-clock, which is RunClock's job). Tracks
 * the two non-time limits v1 got right: cumulative OUTPUT tokens and real billed cost.
 * Input tokens are observability-only (they re-count the growing context every turn) and
 * are NEVER a gate. Sampled, not timer-driven.
 */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Real billed cost for this turn, threaded from provider usage — not fabricated tier×duration. */
  readonly costUsd?: number;
}

/** A deterministic, up-front slice of a parent budget for a delegated child. */
export interface BudgetSlice {
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface Budget {
  remainingOutputTokens(): number;
  remainingCostUsd(): number;
  /** Observability only (feeds compaction). NEVER a gate. */
  inputTokensSeen(): number;
  debit(usage: TokenUsage): void;
  /** A deterministic slice for a child; the child's own debits also propagate up here. */
  carveChild(weight: number, totalWeight: number): BudgetSlice;
}

class BudgetImpl implements Budget {
  private outputRemaining: number;
  private costRemaining: number;
  private inputSeen = 0;

  constructor(outputCap: number, costCapUsd: number) {
    this.outputRemaining = outputCap;
    this.costRemaining = costCapUsd;
  }

  remainingOutputTokens(): number {
    return this.outputRemaining;
  }

  remainingCostUsd(): number {
    return this.costRemaining;
  }

  inputTokensSeen(): number {
    return this.inputSeen;
  }

  debit(usage: TokenUsage): void {
    this.inputSeen += Math.max(0, usage.inputTokens);
    this.outputRemaining -= Math.max(0, usage.outputTokens);
    this.costRemaining -= Math.max(0, usage.costUsd ?? 0);
  }

  carveChild(weight: number, totalWeight: number): BudgetSlice {
    const frac = totalWeight > 0 ? Math.max(0, Math.min(1, weight / totalWeight)) : 0;
    return {
      outputTokens: Math.floor(Math.max(0, this.outputRemaining) * frac),
      costUsd: Math.max(0, this.costRemaining) * frac,
    };
  }
}

export function createBudget(outputCap: number, costCapUsd: number): Budget {
  return new BudgetImpl(outputCap, costCapUsd);
}
