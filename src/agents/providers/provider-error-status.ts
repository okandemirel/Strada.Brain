/**
 * What a provider error says about itself, read one way by both health
 * classifiers: the fallback chain's (per member) and the orchestrator's (for
 * the provider a chat holds, which is a bare seat when the model is hard-pinned).
 *
 * Its own module because fallback-chain.ts imports orchestrator-runtime-utils.ts,
 * so neither can import the other's copy. Two copies is how providers#1 stayed
 * open: the chain stopped benching a seat over a 401 `ModelError`, and the
 * orchestrator kept doing it for `/model pin opencode/<unserved model>`.
 */

/**
 * A model-availability error: an OpenAI-compatible gateway reports the configured
 * model id as unknown/unsupported (OpenCode/Zen returns this under a 401 with a
 * `ModelError` body). This is a per-provider CONFIG mismatch, NOT an auth failure —
 * it must remain RETRYABLE so a healthy sibling provider is tried instead of
 * collapsing the chain to a false "All providers failed".
 */
export const MODEL_UNSUPPORTED_RE = /ModelError|model[\s\S]{0,80}not supported|unsupported model|no such model|model[\s\S]{0,40}(not found|does not exist)/i;

/**
 * The HTTP status an error reports, when it says so: an SDK's numeric `status`,
 * or the leading marker the adapters write ("<name> API error 401: …",
 * "(HTTP 401)", or an SDK message that starts with the status).
 */
export function httpStatusOf(error: unknown, msg: string): number | undefined {
  const status = error !== null && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number") return status;
  const m = /\bAPI error (\d{3})\b|\bHTTP (\d{3})\b|^(\d{3})\b/.exec(msg);
  const code = m?.[1] ?? m?.[2] ?? m?.[3];
  return code === undefined ? undefined : Number(code);
}

/**
 * Whether the error reports one of `codes`. The status the error states
 * decides; a bare number in the text counts only when it states none, since a
 * 400 body can cite `messages[503]` and is not an overload for it.
 */
export function reportsHttpStatus(error: unknown, msg: string, codes: readonly number[]): boolean {
  const status = httpStatusOf(error, msg);
  if (status !== undefined) return codes.includes(status);
  return new RegExp(`\\b(?:${codes.join("|")})\\b`).test(msg);
}
