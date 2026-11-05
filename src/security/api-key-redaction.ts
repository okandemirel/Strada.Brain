/**
 * API-key redaction: one regex for the key prefixes that most often leak into
 * text the model reads (tool results, errors, summaries, retrieved memory), and
 * its variant for the text of project files. The wider 26-pattern set is
 * secret-patterns.ts.
 */

// The lookbehind is load-bearing: without it, the substring "sk-" inside an
// ordinary word matches — measured 2026-08-26: a workspace-lease path like
// "…/strada-workspaces/task-<id>/Assets" redacted to "ta[REDACTED]",
// hiding the lease root from the agent in the very error meant to redirect it,
// which looped until the circuit breaker disabled git_status and shell_exec.
const API_KEY_PATTERN =
  /(?<![A-Za-z0-9])(?:sk-|key-|token-|api[_-]?key[=: ]+|ghp_|gho_|ghu_|ghs_|ghr_|xox[bpas]-|Bearer\s+|AKIA[0-9A-Z]{16}|-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----|mongodb(?:\+srv)?:\/\/[^\s]+@)[a-zA-Z0-9_\-.]{10,}/gi;

export function redactSensitiveText(raw: string): string {
  return raw.replace(API_KEY_PATTERN, "[REDACTED]");
}

/**
 * Prefixes that also start ordinary identifiers and prose. In project files
 * "token-refresh-interval-seconds", class="key-binding-panel-root" and
 * "// Bearer authentication_scheme" all matched API_KEY_PATTERN; the model was
 * shown [REDACTED], so an edit copying the line missed and a read-then-rewrite
 * wrote the placeholder over the identifier.
 */
const WORD_LIKE_SECRET_PREFIX_RE = /^(?:sk-|key-|token-|api[_-]?key[=: ]+|Bearer\s+)/i;
/**
 * The run of letters and digits a generated key has and a word-joined
 * identifier does not: 16+ with a digit in it, or 24+ of any kind.
 */
const SECRET_SHAPED_RUN_RE = /[A-Za-z0-9]{24,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}/;

/**
 * {@link redactSensitiveText} for the text of project files: a match behind a
 * word-like prefix is redacted only when what follows it is shaped like a key.
 */
export function redactSecretsInFileText(raw: string): string {
  return raw.replace(API_KEY_PATTERN, (match) => {
    const prefix = WORD_LIKE_SECRET_PREFIX_RE.exec(match)?.[0];
    if (prefix !== undefined && !SECRET_SHAPED_RUN_RE.test(match.slice(prefix.length))) return match;
    return "[REDACTED]";
  });
}
