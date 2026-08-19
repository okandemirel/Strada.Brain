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
  "task_stuck",
  "token_budget_exceeded",
]);

export function isFailedTerminalKey(key: string | undefined): boolean {
  return key !== undefined && FAILED_TERMINAL_KEYS.has(key);
}
