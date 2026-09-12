/**
 * When the SYSTEM stopped a task, said in a way prose cannot imitate.
 *
 * The campaign exempts a sprint from its attempt budget and its time box when
 * the operator stopped the process — a deploy or a restart is not the sprint
 * failing. That exemption was decided by a regex over the task's output
 * (`/shutting down|shutdown/i`), so a game defect reported as "The shutdown
 * menu does not save progress" bought unlimited free retries: twenty failures
 * produced twenty resubmissions with attempts unchanged (Codex 2026-09-12
 * AD#14).
 *
 * Every prose classifier is defeated by prose moving. The three places the
 * system itself writes an interruption stamp this marker at the START of the
 * message; nothing else does, and the reader requires that position.
 */
export const SYSTEM_INTERRUPTION_MARKER = "[strada:interrupted=system]";

/** The abort reason the executor uses when the process itself is going away. */
export const SHUTDOWN_ABORT_REASON = "shutting down";

/** Did the SYSTEM stop this task — not the task reporting the word? */
export function systemInterrupted(text: string | undefined): boolean {
  return (text ?? "").trimStart().startsWith(SYSTEM_INTERRUPTION_MARKER);
}

/** The marker, once, in front of a message a person reads. */
export function markSystemInterruption(message: string): string {
  return systemInterrupted(message) ? message : `${SYSTEM_INTERRUPTION_MARKER} ${message}`;
}
