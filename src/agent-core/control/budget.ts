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

/**
 * What a delegated child run is opened with: the slice carved for it and the parent Budget its
 * own debits propagate up to. The child gates on the slice; the parent sees the child's spend.
 */
export interface ChildBudget {
  readonly slice: BudgetSlice;
  readonly parent: Budget;
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

  constructor(
    outputCap: number,
    costCapUsd: number,
    private readonly parent?: Budget,
  ) {
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
    // A child's spend is the parent's spend too: without this a sub-agent spent off the books and
    // the parent (and its siblings) gated on headroom that was already gone.
    this.parent?.debit(usage);
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

/** `parent`: a delegated child's budget — every debit here is also debited there. */
export function createBudget(outputCap: number, costCapUsd: number, parent?: Budget): Budget {
  return new BudgetImpl(outputCap, costCapUsd, parent);
}

/** One child opened from a {@link ChildBudgetPool}; `close()` it when the child's run ends. */
export interface PooledChildBudget {
  readonly childBudget: ChildBudget;
  close(): void;
}

/**
 * Slices of one parent budget for children that run at the same time, which together never
 * hold more than the parent has.
 */
export interface ChildBudgetPool {
  /** Carve the next child's slice: an even share of what no live child holds, over the free slots. */
  open(): PooledChildBudget;
}

/**
 * `carveChild` alone cannot bound concurrent children: it slices the parent's REMAINING, and a
 * running sibling's unspent slice is still part of that, so a child that starts while another
 * runs is carved from money already promised. The pool carves from what the parent has left
 * minus what its live children still hold, split evenly over the `slots` that can still start
 * (the caller's concurrency). A closed child's unspent remainder returns to the pool; its spend
 * stays debited to the parent.
 */
export function createChildBudgetPool(parent: Budget, slots: number): ChildBudgetPool {
  const live = new Set<Budget>();
  const unheld = (total: number, held: (b: Budget) => number): number => {
    if (total === Number.POSITIVE_INFINITY) return total;
    let reserved = 0;
    for (const child of live) reserved += Math.max(0, held(child));
    return Math.max(0, total - reserved);
  };
  return {
    open(): PooledChildBudget {
      const share = 1 / Math.max(1, Math.floor(slots) - live.size);
      const slice: BudgetSlice = {
        outputTokens: Math.floor(unheld(parent.remainingOutputTokens(), (b) => b.remainingOutputTokens()) * share),
        costUsd: unheld(parent.remainingCostUsd(), (b) => b.remainingCostUsd()) * share,
      };
      // The holder is the child's parent: it gates the child's spend at the slice and passes
      // every debit on up, and while it is live its unspent remainder is held back from siblings.
      const holder = createBudget(slice.outputTokens, slice.costUsd, parent);
      live.add(holder);
      return { childBudget: { slice, parent: holder }, close: () => { live.delete(holder); } };
    },
  };
}
