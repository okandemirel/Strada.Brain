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
  /**
   * Raise the OUTPUT-token cap of a LIVE run (the mid-task `/token` raise). Raise-only: a newCap
   * not strictly greater than the current cap is ignored, so a concurrent config LOWERING can never
   * strand an in-flight run below what it has already spent (and a child's carved slice is untouched).
   * The per-iteration gate re-reads remainingOutputTokens(), so the new headroom is observed on the
   * next tick. Returns true iff the cap actually grew.
   */
  raiseOutputCap(newCap: number): boolean;
  /** The current OUTPUT-token cap (Infinity when the run has no token cap). */
  outputTokenCap(): number;
  /** OUTPUT tokens debited so far — the "used" a budget-stop checkpoint must persist. */
  spentOutputTokens(): number;
}

class BudgetImpl implements Budget {
  private outputRemaining: number;
  /** The current cap (== outputRemaining + spent). Tracked so a raise adds only the delta. */
  private outputCap: number;
  private costRemaining: number;
  private inputSeen = 0;
  /** Tracked separately from cap-minus-remaining so an Infinity cap still yields a finite spend. */
  private outputSpent = 0;

  constructor(outputCap: number, costCapUsd: number) {
    this.outputRemaining = outputCap;
    this.outputCap = outputCap;
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
    this.outputSpent += Math.max(0, usage.outputTokens);
    this.costRemaining -= Math.max(0, usage.costUsd ?? 0);
  }

  outputTokenCap(): number {
    return this.outputCap;
  }

  spentOutputTokens(): number {
    return this.outputSpent;
  }

  raiseOutputCap(newCap: number): boolean {
    if (!(newCap > this.outputCap)) return false;
    this.outputRemaining += newCap - this.outputCap;
    this.outputCap = newCap;
    return true;
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
