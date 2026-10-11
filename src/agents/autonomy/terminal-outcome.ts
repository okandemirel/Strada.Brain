import { renderingsOf, type MessageKey } from "../resilience-messages.js";
import { TERMINAL_KEYS, type TerminalKey } from "./terminal-key.js";

/**
 * Which terminal outcomes mean the run did not succeed.
 *
 * A run that told the user "the AI provider is not responding" was still
 * recorded as failed:false, because the episode settlement defaulted to success
 * and nothing carried the outcome out to it. Two measured runs each surfaced
 * that notice twice and both closed clean, so a report of success covered a run
 * that had told the user the opposite.
 */
export const FAILED_TERMINAL_KEYS: ReadonlySet<string> = new Set([
  "provider_abort",
  // A quota stop is a real stop: the work did not finish. It is not the
  // agent's failure, but reporting it as success would hide an unfinished run.
  "provider_quota",
  "task_stuck",
  "token_budget_exceeded",
  // The spending limit stopped the work before it finished.
  "cost_budget_exceeded",
]);

export function isFailedTerminalKey(key: string | undefined): boolean {
  return key !== undefined && FAILED_TERMINAL_KEYS.has(key);
}

type RunStatus = "completed" | "failed" | "blocked";

/**
 * What a terminal reason says on its own. `message` is absent when the reason
 * names no notice of its own and the run's status decides it, as it always has.
 */
interface ReasonReading {
  readonly key: TerminalKey;
  readonly message?: MessageKey;
}

/**
 * The reasons the spine writes: describeCancelReason (cancel-reason.ts) and
 * the literal terminalReason assignments in v2-agent-runner.ts. The key says
 * who stopped the run; the notice is the sentence the user has always read for
 * it. They are not one function of the other — a cost-cap stop and a
 * wall-clock timeout are both `cut_short`, yet the user is told different
 * things — so both come out of this one table.
 */
function readReason(reason: string): ReasonReading | undefined {
  if (reason.startsWith("budget-exhausted")) {
    // The spending limit is not a provider outage, and "switch to a different
    // provider" is the wrong advice for it.
    return reason.endsWith(":tokens")
      ? { key: "token_budget_exceeded", message: "token_budget_exceeded" }
      : { key: "cut_short", message: "cost_budget_exceeded" };
  }
  if (reason.startsWith("provider-stall")) return { key: "provider_abort", message: "provider_abort" };
  // A wall-clock or silence ceiling cut the run off. The notice has always
  // blamed the provider; the key does not, because nothing measured says so.
  if (reason.startsWith("hard-timeout") || reason === "task-inactivity") {
    return { key: "cut_short", message: "provider_abort" };
  }
  if (reason.startsWith("verdict-stop")) {
    return reason.endsWith(":loop-detected")
      ? { key: "task_stuck", message: "task_stuck" }
      : { key: "provider_abort", message: "provider_abort" };
  }
  // ask_user terminals, and a fleet outage with a known expiry: the same
  // localized escalation text, but the outage is not tagged ask_user, so the
  // mission keep-alive waits out the cooldown instead of parking the sprint on
  // a question no human needs to answer.
  if (reason.includes("ask_user") || reason.includes("provider_unavailable")) {
    return { key: "provider_ask_user", message: "provider_ask_user" };
  }
  // A provider that kept failing stopped the run, whatever the background
  // notice has always called it.
  if (reason === "provider-failure") return { key: "provider_abort", message: "task_stuck" };
  if (reason === "max-tokens-runaway" || reason === "epoch-budget-exhausted") {
    return { key: "task_stuck", message: "task_stuck" };
  }
  // Background never reaches max-iterations (interactive-only via the
  // adapter), but a notice beats a false success.
  if (reason === "max-iterations") return { key: "max_steps_reached", message: "max_steps_reached" };
  if (reason.startsWith("parent-cancelled")) {
    // describeCancelReason wraps the root cause: a node its parent stopped
    // ended for the parent's reason. The notice is the generic abort for
    // every root, benign ones included, as it has been.
    const root = /^parent-cancelled\((.*)\)$/s.exec(reason)?.[1];
    return { key: (root === undefined ? undefined : readReason(root)?.key) ?? "interrupted", message: "provider_abort" };
  }
  // Benign cancels: a person or a shutdown stopped the run, not the run.
  if (reason === "user-cancel" || reason === "task-winddown") return { key: "interrupted" };
  // A redundant sibling won: the goal this run served is met.
  if (reason === "first-success-satisfied") return { key: "done" };
  // The worker's own NOT DELIVERED — an honest failure report, a reflection
  // that settled blocked, a write the self-managed review refused.
  if (
    reason === "failed" ||
    reason === "terminal-failure" ||
    reason === "blocked" ||
    reason === "self-managed-write-rejected"
  ) {
    return { key: "task_stuck" };
  }
  if (reason === "done" || reason === "end_turn" || reason === "plan-review" || reason === "goal-handoff") {
    return { key: "done" };
  }
  return undefined;
}

interface TerminalReading {
  readonly key: TerminalKey;
  readonly message: MessageKey | undefined;
}

function readTerminal(
  reason: string | undefined,
  status: RunStatus | undefined,
  quotaStopped: (() => boolean) | undefined,
): TerminalReading {
  const read = reason ? readReason(reason) : undefined;
  if (read?.message) return { key: read.key, message: read.message };
  // A hard-FAILED status the reason does not explain must still avoid a false
  // success. The registry is asked only here: a quota stop is the provider's,
  // and saying "not responding" about a provider that answered precisely is
  // the wrong advice (measured 2026-08-21).
  if (status === "failed") {
    const quota = quotaStopped?.() === true;
    return {
      key: read?.key ?? (quota ? "provider_quota" : "error"),
      message: quota ? "provider_quota" : "provider_abort",
    };
  }
  // A blocked run whose reason names nothing did not finish either; a clean
  // status with no recognized reason is the neutral "Task completed.".
  return { key: read?.key ?? (status === "blocked" ? "error" : "done"), message: undefined };
}

/**
 * How the run ended, as data (GDD-drift W01). Finer than the notice: a
 * timeout or the cost cap is `cut_short`, a person's or a shutdown's stop is
 * `interrupted`, and a failure nothing explains is `error` — never a clean
 * finish and never, without the registry saying so, the provider's.
 */
export function terminalKeyOf(
  reason: string | undefined,
  status: RunStatus | undefined,
  quotaStopped?: () => boolean,
): TerminalKey {
  return readTerminal(reason, status, quotaStopped).key;
}

/**
 * The localized notice for a terminal the run left no visible message for;
 * undefined for a clean terminal, so the neutral "Task completed." stands.
 * Byte-identical to the mapper the orchestrator carried before W01.
 */
export function terminalMessageKeyOf(
  reason: string | undefined,
  status: RunStatus | undefined,
  quotaStopped?: () => boolean,
): MessageKey | undefined {
  return readTerminal(reason, status, quotaStopped).message;
}

/** The notices the system writes into a run's result when the run stops. */
const STAMPED_KEYS: readonly (TerminalKey & MessageKey)[] = [
  "task_stuck",
  "provider_abort",
  "provider_quota",
  "token_budget_exceeded",
  "max_steps_reached",
];

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;
const collapseSpace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The fixed text of a template, cut at its `{param}`s and again at sentence
 * ends, keeping only pieces long enough that nothing but the template holds
 * them. Whole segments are kept too: a short sentence next to a parameter
 * ("Use `/token -1` for unlimited.") is distinctive only with its neighbour.
 */
function stampPieces(template: string): string[] {
  const pieces = new Set<string>();
  for (const segment of template.split(/\{[a-z]+\}/)) {
    for (const piece of [segment, ...segment.split(/(?<=[.!?])\s+|(?<=[。！？])/)]) {
      const text = collapseSpace(piece);
      if (text.length >= (CJK_RE.test(text) ? 15 : 40)) pieces.add(text);
    }
  }
  return [...pieces];
}

const STAMP_PIECES: ReadonlyMap<TerminalKey, readonly string[]> = new Map(
  STAMPED_KEYS.map((key) => [key, renderingsOf(key).flatMap(stampPieces)]),
);

/**
 * The system's own terminal notices in a stored result, in any locale, worst
 * first. A result written before the key was carried says how its run ended
 * only through these; a sentence counts only when it is the system's own
 * template text, so a worker's report that mentions getting stuck is not one.
 * A piece survives an excerpt that cut the notice's start (18d4t m1 begins
 * "fter multiple approaches…").
 */
export function systemStampsIn(text: string | null | undefined): TerminalKey[] {
  if (!text) return [];
  const haystack = collapseSpace(text);
  return TERMINAL_KEYS.filter((key) => STAMP_PIECES.get(key)?.some((piece) => haystack.includes(piece)) === true);
}
