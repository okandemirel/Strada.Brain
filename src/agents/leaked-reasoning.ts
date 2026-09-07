/**
 * Thinking blocks a provider leaked into the visible reply.
 *
 * Measured 2026-09-07 (campaign mcov1): 100 replies in the run log begin
 * "<reasoning>\nHere's a thinking process:" — from the OpenCode chain — and
 * three different parsers met them three different ways: the coverage audit
 * extracted the first `{…}` from inside the block and called the audit
 * "malformed JSON"; the goal decomposer failed to parse; the supervisor
 * verifier pasted 240 chars of it as a finding. One rule, applied before any
 * of them read the reply.
 */

/** `<reasoning>…</reasoning>` / `<think>…</think>`, closed — removable. */
const TERMINATED_REASONING_RE = /<(reasoning|think)>[\s\S]*?<\/\1>/giu;
/** A block that opened and never closed: everything after it is thinking. */
const UNTERMINATED_REASONING_RE = /^\s*<(reasoning|think)>/iu;

export interface LeakedReasoning {
  /** The reply with every closed thinking block removed, trimmed. */
  readonly text: string;
  /** True when what remains is an unclosed block — the reply holds no answer at all. */
  readonly reasoningOnly: boolean;
}

export function stripLeakedReasoning(reply: string | undefined): LeakedReasoning {
  const text = (reply ?? "").replace(TERMINATED_REASONING_RE, "").trim();
  return { text, reasoningOnly: UNTERMINATED_REASONING_RE.test(text) };
}
