/**
 * THE BATCH-PLANNING CONTRACT — one place for what "all", the catalogue, the
 * allowance and the headroom mean (plan 0-B.4, 0-B.5, 1.6).
 *
 * Three findings shared one cause, the rules living in three places:
 * - a batch computed from time and the producer's cap, not from the catalogue,
 *   asked a three-level game for sessions 1-5 (Codex 2026-09-13 AK#4);
 * - "at least one fits" answered a round whose allowance exceeds one run's
 *   budget with the same one-session request the producer had just refused
 *   (AK#5);
 * - the worker contract demanded the literal "all" that the producer budgets
 *   as its whole cap and refuses for long rounds (AK#3).
 *
 * The plan below is what the coordinator dispatches, what the gate asks for
 * next, and what the worker is told to call. The producer's arithmetic is
 * mirrored in `sessionsThatFitOneRun`.
 */
import {
  DEFAULT_BOOT_DEADLINE_SECONDS,
  DEFAULT_SESSION_DEADLINE_SECONDS,
  MAX_SESSIONS_PER_RUN,
  PLAY_RUN_BUDGET_MS,
  nextSessionBatch,
  sessionsThatFitOneRun,
} from "./producer-evidence.js";

export interface BatchPlanInput {
  /** Sessions the game reports, when known FOR THIS ARTIFACT; unknown means discover. */
  readonly catalogue?: number;
  /** Sessions already played to an outcome on this artifact. */
  readonly played: readonly number[];
  /** The document's longest legitimate round, when it states one: the floor no trim goes below. */
  readonly roundSeconds?: number;
  /** The allowance proposed for one session, headroom included. */
  readonly deadlineSeconds?: number;
  readonly bootSeconds?: number;
  readonly budgetMs?: number;
  readonly cap?: number;
}

export type BatchPlan =
  /** The catalogue is unknown: a request the producer resolves against what it reads now. */
  | { readonly kind: "discover"; readonly sessions: string; readonly deadlineSeconds: number; readonly trimmed?: string }
  /** The next sessions nobody has played, clipped to the catalogue and to what fits one run. */
  | { readonly kind: "batch"; readonly sessions: string; readonly deadlineSeconds: number; readonly trimmed?: string }
  /** Everything is played: a re-measurement of the first batch, never a claim of coverage. */
  | { readonly kind: "covered"; readonly sessions: string; readonly deadlineSeconds: number; readonly trimmed?: string }
  /** No allowance that respects the document's round fits one run: an explicit refusal, never a re-proposal. */
  | { readonly kind: "unfit"; readonly reason: string };

/** The largest per-session allowance one run's budget can hold, at this boot allowance. */
export function largestDeadlineThatFits(bootSeconds: number, budgetMs: number = PLAY_RUN_BUDGET_MS): number {
  const overhead = (bootSeconds + 15) * 1000 + 30_000;
  return Math.floor((budgetMs - overhead) / 1000) - 5;
}

export function planSessionBatch(input: BatchPlanInput): BatchPlan {
  const cap = input.cap ?? MAX_SESSIONS_PER_RUN;
  const boot = input.bootSeconds ?? DEFAULT_BOOT_DEADLINE_SECONDS;
  let deadline = input.deadlineSeconds ?? DEFAULT_SESSION_DEADLINE_SECONDS;
  let trimmed: string | undefined;
  let fits = sessionsThatFitOneRun(deadline, boot, input.budgetMs);
  if (fits === 0) {
    // ZERO FITS IS AN ANSWER. The headroom is optional; the round is not. An
    // allowance that only exceeds the budget by its headroom is trimmed to
    // what fits and disclosed; a round that itself exceeds the budget is
    // refused by name, with what would have to change (AK#5).
    const largest = largestDeadlineThatFits(boot, input.budgetMs);
    const floor = input.roundSeconds ?? DEFAULT_SESSION_DEADLINE_SECONDS;
    if (largest >= floor) {
      trimmed = `the per-session allowance was trimmed from ${deadline} s to ${largest} s so that one session fits one run`;
      deadline = largest;
      fits = 1;
    } else {
      const budgetSeconds = Math.round((input.budgetMs ?? PLAY_RUN_BUDGET_MS) / 1000);
      return {
        kind: "unfit",
        reason:
          `a round of ${floor} s cannot be played in one run: one session needs more than the ${budgetSeconds} s a run may take ` +
          `(${largest} s is the largest allowance that fits with a ${boot} s boot), and no resumable run is available — ` +
          "the play-through cannot be measured as this document is written",
      };
    }
  }
  const base = { deadlineSeconds: deadline, ...(trimmed === undefined ? {} : { trimmed }) };
  if (input.catalogue === undefined) {
    // DISCOVERY (0-B.4): ONE session. A range guessed from what time allows
    // asked for levels that do not exist (AK#4), and "all" is no better —
    // the producer plays its cap and reports the catalogue, the ticket
    // asked for everything, and the receiver refuses the run as
    // SESSION_MISSING before the catalogue is even remembered (Codex
    // 2026-09-17 round 5 #1). One played session tells the catalogue for
    // the next batch; the coordinator never asks "all".
    return { kind: "discover", sessions: "1", ...base };
  }
  const batchSize = Math.max(1, Math.min(cap, fits, input.catalogue));
  const next = nextSessionBatch(input.catalogue, input.played, batchSize);
  if (next !== undefined) return { kind: "batch", sessions: next, ...base };
  return { kind: "covered", sessions: `1-${Math.min(batchSize, input.catalogue)}`, ...base };
}
