/** How many times a blocked goal tree is replayed without a human. */
export const MAX_AUTO_RESUMES = 3;
/** How many times a stalled goal is planned again from scratch. */
export const MAX_AUTO_REPLANS = 2;

export interface AutoResumeState {
  /** Replays already spent on this goal root. */
  readonly attempts: number;
  /** Fresh plans already produced for this goal root. */
  readonly replans: number;
  /** Nodes completed as of the previous round, for detecting a stall. */
  readonly previousSucceeded: number;
}

export type AutoResumeAction = "resume" | "replan" | "stop";

export interface AutoResumeDecision {
  readonly action: AutoResumeAction;
  /** Said out loud in the log, because a run that changes course has to say why. */
  readonly reason: string;
}

/**
 * What to do with a goal tree that stopped with work left in it.
 *
 * Three answers, and the middle one is the point. Replaying a tree
 * (prepareTreeForRetry keeps the completed nodes and resets the rest) is right
 * while rounds are still finishing nodes. It is useless once they are not:
 * measured 2026-08-22, run 40 resumed once, the same two nodes failed the same
 * way, and the run stopped — correctly, under the old rule, but a round that
 * repeats itself is exactly the moment to plan differently rather than to give
 * up. Replanning throws the tree away and decomposes again with the failure
 * reasons as input, which is the one thing a replay cannot do.
 *
 * The bounds stay: three replays, two fresh plans. A third identical outcome
 * means the obstacle is not the plan, and a person should look.
 */
export function decideAutoResume(
  state: AutoResumeState,
  succeeded: number,
): AutoResumeDecision {
  if (state.attempts >= MAX_AUTO_RESUMES) {
    return {
      action: "stop",
      reason: `already replayed ${state.attempts} times without finishing; stopping so a person can look`,
    };
  }

  const firstBlock = state.attempts === 0;
  const madeProgress = succeeded > state.previousSucceeded;
  if (firstBlock || madeProgress) {
    return {
      action: "resume",
      reason: firstBlock
        ? "first block on this goal; the failed nodes are worth one retry"
        : `progress since the last round (${state.previousSucceeded} -> ${succeeded} nodes complete)`,
    };
  }

  if (state.replans < MAX_AUTO_REPLANS) {
    return {
      action: "replan",
      reason:
        `the last round completed no new nodes (${succeeded} of them, same as before), ` +
        "so the plan is what changes, not the number of attempts",
    };
  }

  return {
    action: "stop",
    reason: `${state.replans} fresh plans produced nothing new either; the obstacle is not the plan, so a person can look`,
  };
}

// ---------------------------------------------------------------------------
// Mission keep-alive — the LAST stop is a report, not silence.
// ---------------------------------------------------------------------------

/**
 * How many automatic mission-level retries (full resubmission of the original
 * prompt) may run before the failure is escalated to the person. Only two
 * stops are legitimate per product contract: the TIME window and the BUDGET.
 * Everything else keeps feeding back in.
 */
export const MAX_MISSION_RETRIES = 10;

/** Backoff between mission retries: 30s doubling, capped at 10 minutes. */
export function missionRetryBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt), 600_000);
}

export interface MissionKeepAliveDecision {
  readonly action: "retry" | "report";
  readonly attempt: number;
  readonly backoffMs: number;
  /** Why, when action === "report" — this text reaches the channel verbatim. */
  readonly reportReason?: string;
}

/** Pure decision for whether an exhausted-looking failure keeps going or escalates. */
export function decideMissionKeepAlive(
  attempt: number,
  opts: { budgetExceeded: boolean },
): MissionKeepAliveDecision {
  if (opts.budgetExceeded) {
    return {
      action: "report",
      attempt,
      backoffMs: 0,
      reportReason: `Budget limit reached after ${attempt} automatic retries — stopping is the contract, not a crash.`,
    };
  }
  if (attempt >= MAX_MISSION_RETRIES) {
    return {
      action: "report",
      attempt,
      backoffMs: 0,
      reportReason:
        `Persistently failing after ${MAX_MISSION_RETRIES} automatic retries. Last blocker: this needs a human decision before work can continue.`,
    };
  }
  return { action: "retry", attempt, backoffMs: missionRetryBackoffMs(attempt) };
}
