/**
 * How a run ended, as data rather than as a sentence.
 *
 * In campaign 18d4t every milestone tip but one carried the system's own
 * "task_stuck" stamp, and all six went green: the only record of how a run
 * ended was the localized text it showed the user, and the gate read prose.
 * The key is carried from the agent runtime to the task's verification
 * (GDD-drift plan W01); the scope gate folds a run's keys into the worst one.
 */

export type TerminalKey =
  | "done"
  | "task_stuck"
  | "max_steps_reached"
  | "token_budget_exceeded"
  | "cut_short"
  | "error"
  | "provider_quota"
  | "provider_abort"
  | "provider_ask_user"
  | "interrupted";

/**
 * Every key. Inside one class, the key listed first is the worse one, so
 * folding the same keys always names the same reason.
 */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  "task_stuck",
  "max_steps_reached",
  "token_budget_exceeded",
  "cut_short",
  "error",
  "provider_quota",
  "provider_abort",
  "provider_ask_user",
  "interrupted",
  "done",
];

/**
 * The run did not finish its work, and nothing outside it is to blame. A
 * crash (`error`) is here, not with the outages: a run that is never charged
 * can be resubmitted forever, and nothing says the provider caused it.
 */
export const RED_TERMINALS: ReadonlySet<TerminalKey> = new Set<TerminalKey>([
  "task_stuck",
  "max_steps_reached",
  "token_budget_exceeded",
  "cut_short",
  "error",
]);

/** The provider stopped the run: never charged to the worker, and always outranked by a red key. */
export const OUTAGE_TERMINALS: ReadonlySet<TerminalKey> = new Set<TerminalKey>([
  "provider_quota",
  "provider_abort",
  "provider_ask_user",
]);

export type TerminalClass = "red" | "outage" | "interrupted" | "done";

export function terminalClass(key: TerminalKey): TerminalClass {
  if (RED_TERMINALS.has(key)) return "red";
  if (OUTAGE_TERMINALS.has(key)) return "outage";
  return key === "done" ? "done" : "interrupted";
}

const CLASS_RANK: Record<TerminalClass, number> = { red: 3, outage: 2, interrupted: 1, done: 0 };

export function isTerminalKey(value: unknown): value is TerminalKey {
  return typeof value === "string" && (TERMINAL_KEYS as readonly string[]).includes(value);
}

/**
 * The key that speaks for the whole run: red, then outage, then interrupted,
 * then done. Undefined when there is no key at all — a run nothing reported
 * on is not a clean finish, and the caller has to say what it measured.
 */
export function worstTerminal(keys: Iterable<TerminalKey>): TerminalKey | undefined {
  let worst: TerminalKey | undefined;
  for (const key of keys) {
    if (worst === undefined) {
      worst = key;
      continue;
    }
    const byClass = CLASS_RANK[terminalClass(key)] - CLASS_RANK[terminalClass(worst)];
    if (byClass > 0 || (byClass === 0 && TERMINAL_KEYS.indexOf(key) < TERMINAL_KEYS.indexOf(worst))) worst = key;
  }
  return worst;
}

/** What a settled run says about its own integrity; rides on `Task.verification.runIntegrity`. */
export interface RunIntegrity {
  /** The key each node ended on (one entry for a direct run), in settle order. */
  readonly terminalKeys: readonly TerminalKey[];
  /** `worstTerminal(terminalKeys)`. */
  readonly worst: TerminalKey;
  /**
   * `spine`: carried as data from the runtime. `legacy-stamp`: decoded from
   * the system's own stamps in a result written before the key was carried.
   */
  readonly source: "spine" | "legacy-stamp";
  /** Distinct models that did the work; a check's writer is independent only of these. */
  readonly workerModels: readonly string[];
  /** How many nodes the run had (supervisor runs). */
  readonly nodes?: number;
  /** How many of them no verifier actually reviewed. */
  readonly unverifiedNodes?: number;
}
