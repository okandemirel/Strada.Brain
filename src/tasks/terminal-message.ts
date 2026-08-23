/**
 * What a user reads when a run stops.
 *
 * A run ends with two descriptions of why: a `reason`, which the control plane
 * writes for itself, and the worker's `output`, which is what it wanted to say
 * to a person. The reason was preferred outright — `reason ?? (output || ...)` —
 * and reason is essentially always set, so output was unreachable.
 *
 * Measured 2026-08-23 on run 53: the agent stopped to ask a question, the
 * control plane wrote `blocked:ask_user`, and that sixteen-character tag became
 * the entire stored result. The question itself — 119 characters, the only part
 * anyone could act on — was discarded. An unattended run that stops to ask
 * something and will not say what it asked cannot be answered, and cannot be
 * resumed.
 */

/**
 * A control-plane tag rather than a sentence: "blocked", "blocked:ask_user",
 * "failed:provider:timeout".
 *
 * No spaces and no capitals is the whole test. Anything a person wrote to
 * explain an ending has one or the other — "Compilation failed: 3 errors" keeps
 * its colon and is still an explanation.
 */
const MACHINE_TAG_RE = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*$/u;

function isMachineTag(text: string): boolean {
  return MACHINE_TAG_RE.test(text);
}

/**
 * The message to store and show for a terminal outcome.
 *
 * The reason usually IS the explanation — "All providers failed: ..." — and
 * stays preferred. What changes is that a bare tag never wins over something a
 * person can read: it identifies the branch for the log, and the log already
 * has it from "Task settling".
 */
export function terminalMessage(
  reason: string | null | undefined,
  output: string | null | undefined,
  fallback: string,
): string {
  const trimmedReason = reason?.trim() ?? "";
  const trimmedOutput = output?.trim() ?? "";

  if (trimmedReason !== "" && !isMachineTag(trimmedReason)) return trimmedReason;
  if (trimmedOutput !== "") return trimmedOutput;
  return trimmedReason !== "" ? trimmedReason : fallback;
}
