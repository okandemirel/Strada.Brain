/**
 * User-facing error message classifier.
 *
 * Converts internal error messages into actionable, user-friendly text
 * without leaking sensitive implementation details.
 */

/** Known error categories for classification. */
type ErrorCategory =
  | "providers_exhausted"
  | "network"
  | "budget"
  | "rate_limit"
  | "cancelled"
  | "auth"
  | "context_length"
  | "task_interrupted"
  | "unknown";

/**
 * What each category looks like when a provider or the runtime states it.
 *
 * A bare substring is not enough: the words turn up inside the very errors the
 * classifier must leave alone. "network" is in Assets/Scripts/Networking/ and
 * NetworkManager, "401" in a token count of 140123, "authentication" in
 * AuthenticationManager.cs, "budget" in `reading 'budget'`. Each of those came
 * back as a provider diagnosis and the real error was dropped. So a status code
 * must be stated as one, and a word must come in the phrase the error uses.
 * Order matters when a message carries two: a context overflow quotes token
 * counts, so it is read before the status codes.
 */
const CATEGORY_PATTERNS: ReadonlyArray<readonly [ErrorCategory, RegExp]> = [
  ["providers_exhausted", /\ball providers failed\b|\bno providers available\b/i],
  ["network", /\bfetch failed\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bnetwork ?(?:error|request failed|is unreachable|unreachable)\b/i],
  ["budget", /\bbudget (?:is )?(?:exceeded|exhausted)\b/i],
  ["rate_limit", /\brate limit/i],
  ["cancelled", /\btask cancelled\b|\baborted\b/i],
  ["context_length", /\bcontext length\b|\btoo many tokens\b|\bmaximum context\b/i],
  ["auth", /\b(?:API error|HTTP|status(?: code)?:?) 401\b|^401\b|\bunauthorized\b|\binvalid api key\b|\bauthentication(?:_error\b| (?:failed|error|required)\b)/i],
  ["task_interrupted", /\btask interrupted\b/i],
];

/** Classify an error string into a known category. */
function classifyCategory(msg: string): ErrorCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(msg)) return category;
  }
  return "unknown";
}

/** Interactive (chat) error messages per category. */
const INTERACTIVE_MESSAGES: Record<ErrorCategory, string | null> = {
  providers_exhausted: "All AI providers are currently unavailable. Please check your API keys and provider configuration.",
  network: "Could not connect to the AI provider. Please check your network connection and whether the service is running.",
  budget: "Request budget exceeded. Please try a shorter request or wait before trying again.",
  rate_limit: "Rate limit reached. Please wait a moment before trying again.",
  cancelled: "The request was cancelled.",
  auth: "Authentication failed with the AI provider. Please check your API key configuration.",
  context_length: "The conversation is too long for the current model. Try starting a new conversation or use a model with a larger context window.",
  task_interrupted: null, // Not applicable to interactive context
  unknown: null,
};

/** Background task error messages per category. */
const TASK_MESSAGES: Record<ErrorCategory, string | null> = {
  providers_exhausted: "I couldn't complete this task because no AI provider is available right now. Please check your provider configuration.",
  network: "I couldn't complete this task because the AI provider is unreachable. Please check your network connection.",
  budget: "This task was stopped because the request budget was exceeded.",
  rate_limit: null, // Falls through to default for tasks
  cancelled: "This task was cancelled.",
  auth: null,
  context_length: null,
  task_interrupted: null, // Handled specially — returns raw message
  unknown: null,
};

/**
 * Classify an error and return a user-friendly message.
 * The raw error string is inspected for known patterns; anything
 * that doesn't match falls through to a safe default.
 */
export function classifyErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const category = classifyCategory(msg);

  const mapped = INTERACTIVE_MESSAGES[category];
  if (mapped) return mapped;

  const brief = sanitizeBrief(msg);
  if (brief) return `An error occurred: ${brief}. Please try again.`;
  return "An unexpected error occurred. Please try again.";
}

/**
 * Build a user-friendly error message specifically for background task failures.
 * Provides slightly more context than the interactive error since background
 * tasks don't have an immediate conversation context.
 */
export function classifyTaskErrorMessage(error: string): string {
  const category = classifyCategory(error);

  // task_interrupted messages are already user-friendly (startup recovery)
  if (category === "task_interrupted") return error;

  const mapped = TASK_MESSAGES[category];
  if (mapped) return mapped;

  const brief = sanitizeBrief(error);
  if (brief) return `Task failed: ${brief}. You can try submitting it again.`;
  return "This task failed unexpectedly. You can try submitting it again.";
}

/**
 * A thrown tool error, as the model should read it.
 *
 * A tool's failure is not an AI-provider failure, so the provider categories do
 * not apply: "Could not connect to the AI provider" for a missing file sent the
 * agent after an outage that never happened. The model gets the real message,
 * with keys and absolute paths stripped as for any displayed error.
 */
export function describeToolError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return sanitizeBrief(msg) || "the tool threw without a message";
}

/**
 * Extract a brief, safe-to-display snippet from an error message.
 * Strips file paths, stack traces, and API keys.
 */
function sanitizeBrief(raw: string): string {
  let text = raw
    // Remove absolute file paths (common system prefixes only, not API endpoints like /v1/chat)
    .replace(/(?:^|\s)(\/(?:Users|home|var|tmp|etc|opt|usr|private)[^\s:,]*)/g, " ")
    // Remove anything that looks like an API key or token (comprehensive patterns)
    .replace(/(?:sk-|sk-ant-|key-|token-|ghp_|gho_|xox[bpas]-|AKIA|AIza|eyJ)[a-zA-Z0-9_\-.]{6,}/gi, "[redacted]")
    // Remove stack trace noise
    .replace(/\s+at\s+.*/g, "")
    // Remove source file references
    .replace(/\b\w+\.(?:ts|js|mjs):\d+/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  // Truncate to something readable
  if (text.length > 120) {
    text = text.slice(0, 117) + "...";
  }

  return text;
}
