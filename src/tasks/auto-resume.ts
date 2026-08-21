/** How many times a blocked goal tree is picked up again without a human. */
export const MAX_AUTO_RESUMES = 3;

export interface AutoResumeState {
  /** Automatic resumes already spent on this goal root. */
  readonly attempts: number;
  /** Nodes completed as of the previous round, for detecting a stall. */
  readonly previousSucceeded: number;
}

export interface AutoResumeDecision {
  readonly resume: boolean;
  /** Said out loud in the log, because a run that stops has to say why. */
  readonly reason: string;
}

/**
 * Whether a partially-finished goal tree should be picked up again.
 *
 * The machinery to resume one already existed and was complete:
 * prepareTreeForRetry keeps every completed node and resets only the failed
 * ones, and taskManager.retryGoalRoot resubmits the tree. Nothing called it
 * except a button in the dashboard. So run 37 worked for sixty-five minutes,
 * finished one node of five, blocked, and ended — with a person asleep and the
 * remaining work sitting ready to be retried.
 *
 * Two bounds keep this from becoming a loop. A hard cap, and a stall rule: a
 * round that completes no new node has learned nothing, and running it again
 * will learn nothing either. The first block is always worth one retry, since
 * a transient failure looks exactly like a permanent one the first time.
 */
export function decideAutoResume(
  state: AutoResumeState,
  succeeded: number,
): AutoResumeDecision {
  if (state.attempts >= MAX_AUTO_RESUMES) {
    return {
      resume: false,
      reason: `already resumed ${state.attempts} times without finishing; stopping so a person can look`,
    };
  }
  if (state.attempts > 0 && succeeded <= state.previousSucceeded) {
    return {
      resume: false,
      reason: `the last round completed no new nodes (${succeeded} of them, same as before); another one would not either`,
    };
  }
  return {
    resume: true,
    reason:
      state.attempts === 0
        ? "first block on this goal; the failed nodes are worth one retry"
        : `progress since the last round (${state.previousSucceeded} -> ${succeeded} nodes complete)`,
  };
}
