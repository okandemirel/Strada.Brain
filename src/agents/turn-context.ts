/**
 * The turn context: what the agent loop rebuilds for every model call, sent at
 * the end of the call's last user turn instead of inside the system prompt.
 *
 * Why it is not in the system prompt. A provider caches a request's prefix,
 * and a cached input token costs about a fiftieth of an uncached one
 * (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md).
 * The system prompt comes before the history, so a system prompt that changes
 * between two calls makes the provider miss the whole history as well. The
 * per-step sections did exactly that: the phase section carries "Current
 * iteration: N", the execution journal and the last reflection, and the role
 * section's routing reasons count runtime outcomes. Measured offline over the
 * daemon logs of 2026-08 to 2026-10 (scripts/eval/compaction-replay.mjs): the
 * system prompt changed length on 93–95% of consecutive calls in a session.
 *
 * So the system prompt is the run's prompt as setup built it, the same bytes
 * on every call, and this context rides at the end of the request, where a
 * change costs only itself. It is never stored in the session: the next call
 * carries its own, and the history stays append-only.
 */

import type { ConversationMessage, MessageContent } from "./providers/provider-core.interface.js";

/** The first line of every turn context, so the model does not read it as the user's words. */
export const TURN_CONTEXT_HEADER =
  "[Turn context from Strada Brain, rebuilt for this call: the current phase, plan, role and run state. It is not a message from the user.]";

/** The sections that are not blank, under the header; "" when every section is blank. */
export function composeTurnContext(sections: ReadonlyArray<string | undefined>): string {
  const body = sections.map((section) => section?.trim() ?? "").filter((section) => section.length > 0);
  return body.length === 0 ? "" : [TURN_CONTEXT_HEADER, ...body].join("\n\n");
}

/** `content` with `text` after everything it already holds. */
function appendText(content: string | MessageContent[], text: string): string | MessageContent[] {
  return typeof content === "string" ? `${content}\n\n${text}` : [...content, { type: "text", text }];
}

/**
 * The messages to send: `messages` with the turn context after the last user
 * turn's content. A conversation that does not end on a user turn gets one
 * that holds only the context. `messages` itself is never changed, and is
 * returned as is when there is no context.
 */
export function withTurnContext(
  messages: ConversationMessage[],
  turnContext: string | undefined,
): ConversationMessage[] {
  if (!turnContext) return messages;
  const last = messages.at(-1);
  if (!last || last.role !== "user") return [...messages, { role: "user", content: turnContext }];
  return [...messages.slice(0, -1), { ...last, content: appendText(last.content, turnContext) }];
}

/**
 * Add `text` to the history for good, at the end of its last user turn. For
 * content that arrives mid-run and must stay (memory recalled during a task):
 * the turn has not been sent yet, so every earlier request stays a prefix of
 * the next one. Returns false, and changes nothing, when the history does not
 * end on a user turn.
 */
export function appendToLastUserTurn(messages: ConversationMessage[], text: string): boolean {
  const last = messages.at(-1);
  if (!text || !last || last.role !== "user") return false;
  messages[messages.length - 1] = { ...last, content: appendText(last.content, text) };
  return true;
}
