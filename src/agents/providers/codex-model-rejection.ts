/**
 * Single source of truth for the ChatGPT/Codex SUBSCRIPTION "configured model is not
 * Codex-supported" contract.
 *
 * A consumer ChatGPT/Codex subscription only serves a fixed set of Codex-enabled
 * models and rejects anything else with HTTP 400/404 ("The 'X' model is not supported
 * when using Codex with a ChatGPT account."). Strada surfaces this as a clear,
 * actionable message and classifies it as a STATIC per-provider config mismatch
 * (non-retryable, no health churn) rather than a transient model error.
 *
 * Three call sites must agree on the EXACT wording, because it is a cross-module
 * contract: the FallbackChain recogniser ({@link CODEX_MODEL_UNSUPPORTED_RE}) matches
 * on the literal "not accepted by the ChatGPT/Codex subscription endpoint" phrase to
 * decide non-retryability. Drift in any one copy silently breaks recognition. They are
 * therefore all built here:
 *   - openai.ts rewriteChatGptModelRejection() / describeChatGptHealthFailure()
 *   - response-provider-preflight.ts getOpenAiSubscriptionFailureDetail()
 *   - fallback-chain.ts (the recogniser regex)
 */

/**
 * Recommended Codex-supported model surfaced in user-facing guidance. Promoted to a
 * single named constant so the suggestion can be updated in one place rather than as a
 * magic literal repeated across files (and distinct from the OpenAIProvider constructor
 * default model).
 */
export const RECOMMENDED_CODEX_MODEL = "gpt-5.4";

/** The actionable tail shared by every Codex model-rejection message. */
const CODEX_MODEL_REJECTION_TAIL =
  `Set the OpenAI model to a Codex-supported one (such as ${RECOMMENDED_CODEX_MODEL}) or switch OpenAI to API-key mode.`;

/**
 * The actionable guidance sentence built for a Codex model rejection.
 *
 * The literal "is not accepted by the ChatGPT/Codex subscription endpoint" phrase is
 * the cross-module contract {@link CODEX_MODEL_UNSUPPORTED_RE} matches on — keep it
 * verbatim. Pass the HTTP status (health-probe path) to include it inline, or the
 * upstream backend detail (live `/responses` path) to append it.
 */
export function codexModelRejectionMessage(
  model: string,
  opts?: { status?: number; backendDetail?: string },
): string {
  const statusSuffix = opts?.status !== undefined ? ` (HTTP ${opts.status})` : "";
  const detailSuffix = opts?.backendDetail ? ` ${opts.backendDetail}` : "";
  return `The configured model "${model}" is not accepted by the ChatGPT/Codex subscription endpoint${statusSuffix}.${detailSuffix} ${CODEX_MODEL_REJECTION_TAIL}`;
}

/**
 * The preflight-summary variant (no specific model in hand — the live probe detail is
 * preferred when available, this is the generic fallback). Reuses the same recommended
 * model + API-key guidance tail.
 */
export function codexSubscriptionProbeFailureMessage(): string {
  return `OpenAI ChatGPT/Codex subscription health probe failed. Verify the configured model is Codex-supported (e.g. ${RECOMMENDED_CODEX_MODEL}) or switch OpenAI to API-key mode.`;
}

/**
 * Detect, from an upstream/raw error message, that a ChatGPT/Codex SUBSCRIPTION
 * rejected the configured model with an HTTP 400/404. Single source of truth for the
 * recognition logic shared by openai.ts (rewriting the raw transport error) and
 * fallback-chain.ts (classifying it non-retryable). Matches both the backend's own
 * phrasing and Strada's rewritten "not accepted by the ChatGPT/Codex subscription
 * endpoint" message.
 */
export const CODEX_MODEL_UNSUPPORTED_RE =
  /not (?:supported when using codex|accepted by the chatgpt\/codex subscription)/i;

/**
 * Stricter predicate for the RAW upstream rejection (used by openai.ts before the
 * message has been rewritten): requires a 400/404 status token AND a model-rejection
 * phrase. Kept separate from {@link CODEX_MODEL_UNSUPPORTED_RE} (which also matches
 * Strada's already-rewritten message, where the status token may be absent).
 */
export function isRawCodexModelRejection(message: string): boolean {
  return (
    /\b40[04]\b/.test(message) &&
    /not supported when using codex|is not supported.*chatgpt|not (a )?valid model|unsupported model/i.test(
      message,
    )
  );
}
