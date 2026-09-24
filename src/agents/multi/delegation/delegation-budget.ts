/**
 * How long a delegation may run, learned from how the last ones ended.
 *
 * Measured 2026-09-07 from the delegation log: 17 code_review sub-agents in
 * one day, every one a timeout at exactly its configured 60 000 ms, plus one
 * analysis at 180 000 — the only live model was a queued free endpoint
 * (first byte 4-70 s, ~30 tokens/s), so the fixed budget could never be
 * met, each attempt first seeded a 2000-file workspace lease, and the
 * "verifier" the delivery report waited for never verified anything.
 *
 * Rule: consecutive timeouts of a type double its budget (capped); once the
 * type has timed out repeatedly AT the cap, the delegation is refused up
 * front — no slot, no budget reservation, no lease — and the parent does the
 * work itself, which is what happened after each 60 s anyway.
 */

export interface DelegationOutcomeLike {
  readonly status: string;
  readonly durationMs: number | undefined;
  /** When the delegation started (epoch ms). Outcomes older than the window are not evidence. */
  readonly startedAt?: number;
}

export const DELEGATION_TIMEOUT_CAP_MS = 600_000;
/** Consecutive timeouts at the cap after which the type is refused. */
export const DELEGATION_REFUSE_AFTER = 3;
/**
 * How far back an outcome still says something about the current model. A refusal is
 * recorded before any new row can be written, so without a window nothing could ever break
 * the streak: one slow afternoon refused the type for good, across restarts and model changes.
 * Once the streak ages out, the next delegation runs as a probe on the configured budget.
 */
export const DELEGATION_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface DelegationBudget {
  readonly timeoutMs: number;
  /** How many of the newest outcomes were timeouts, newest first, stopping at the first non-timeout. */
  readonly consecutiveTimeouts: number;
  /** Set when the type should not be delegated at all right now. */
  readonly refusal?: string;
}

/**
 * `recent` is newest first. A completed (or failed, or cancelled) delegation
 * ends the streak: the budget resets to the configured one. So does an outcome
 * older than {@link DELEGATION_HISTORY_WINDOW_MS}.
 */
export function resolveDelegationBudget(
  type: string,
  configuredTimeoutMs: number,
  recent: readonly DelegationOutcomeLike[],
  now: number = Date.now(),
): DelegationBudget {
  let consecutiveTimeouts = 0;
  for (const entry of recent) {
    // A blocked run stopped short; it is not the success that proves the budget suffices.
    if (entry.status === "blocked") continue;
    if (entry.status !== "timeout") break;
    if (entry.startedAt !== undefined && now - entry.startedAt > DELEGATION_HISTORY_WINDOW_MS) break;
    consecutiveTimeouts++;
  }
  if (consecutiveTimeouts === 0) return { timeoutMs: configuredTimeoutMs, consecutiveTimeouts };

  const timeoutMs = Math.min(DELEGATION_TIMEOUT_CAP_MS, configuredTimeoutMs * 2 ** consecutiveTimeouts);
  // Timeouts that already had (about) the capped budget count toward refusal.
  let atCap = 0;
  for (const entry of recent.slice(0, consecutiveTimeouts)) {
    if ((entry.durationMs ?? 0) >= DELEGATION_TIMEOUT_CAP_MS * 0.95) atCap++;
    else break;
  }
  if (atCap >= DELEGATION_REFUSE_AFTER) {
    return {
      timeoutMs,
      consecutiveTimeouts,
      refusal:
        `Delegation "${type}" refused: its last ${atCap} runs all timed out at the ${Math.round(DELEGATION_TIMEOUT_CAP_MS / 1000)} s cap ` +
        `(${consecutiveTimeouts} timeouts in a row) — the current model cannot finish this kind of sub-task; do it in this agent instead.`,
    };
  }
  return { timeoutMs, consecutiveTimeouts };
}
