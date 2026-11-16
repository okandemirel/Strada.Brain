/**
 * What of a user-role turn is the person's own: the one read behind "what did the user last say"
 * (SessionManager.extractLastUserContent, and extractLastUserMessage, its text).
 *
 * Three kinds of system content sit on user-role turns:
 *  - a tool-result turn: the tool results, then gate notes, the plan-state injection and, in
 *    the reflection phase, the reflection prompt (buildToolResultContentBlocks). None of it is
 *    the person's.
 *  - a call that never answered is answered by normalizeConversation, which folds the user message
 *    after it into the answer behind INTERRUPTED_TOOL_RESULT placeholders (conversation-normalizer.ts
 *    answerFor). Every result of such a turn is a placeholder; its other blocks are the person's.
 *  - a recall the run's ledger appended (recall-ledger.ts).
 * And the system writes plain-text user turns of its own: the gates and the replan prompt. Those
 * are marked where they are pushed (pushSystemTurn below) and hold nothing of the person's.
 *
 * There is one read, and it always passes over these, so the text and the content of the person's
 * last turn come from the same turn: a reader that took the raw turn saw a tool_result as rich
 * input (the interactive goal handoff built no goal tree and handed the task the plan state).
 *
 * Known limit (board proposal #69): when the follower that carries the result comes after the
 * user's message, the normalizer folds both into one turn behind that recorded result, and the
 * user's words there read as the system's.
 */

import { INTERRUPTED_TOOL_RESULT } from "./conversation-normalizer.js";
import { withoutRecalledMemory } from "./recall-ledger.js";
import type { ConversationMessage, MessageContent, UserMessage } from "./providers/provider-core.interface.js";

/** A user turn carrying at least one recorded tool result: its text is the system's. */
export function isSystemToolResultTurn(msg: ConversationMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b.type === "tool_result" && b.content !== INTERRUPTED_TOOL_RESULT);
}

/**
 * The person's part of a user turn, or null when the turn holds nothing of theirs (a gate or the
 * replan prompt, the system's tool-result turn, a bare interrupted answer, a turn that held only a recall). A turn that is
 * empty of itself is returned as it is.
 */
export function personsContent(msg: ConversationMessage): string | MessageContent[] | null {
  if (isSystemTurn(msg) || isSystemToolResultTurn(msg)) return null;
  const raw = msg.content as string | MessageContent[] | null;
  const own = Array.isArray(raw) && raw.some((b) => b.type === "tool_result")
    ? raw.filter((b) => b.type !== "tool_result")
    : raw;
  const content = withoutRecalledMemory([{ ...msg, content: own } as ConversationMessage])[0]!.content as
    string | MessageContent[] | null;
  const emptied = Array.isArray(content) ? content.length === 0 : !content?.trim();
  return emptied && content !== raw ? null : content;
}

/**
 * A user-role turn the system writes for the model: a gate (loop recovery, a
 * verifier, clarification or visibility intervention, the max-tokens
 * continuation) or the replan prompt. The model reads it like any user turn;
 * the read of what the user last said passes over it (personsContent).
 *
 * The mark is a field, not text, so a new gate needs no pattern to be
 * recognised. It stays off the wire: every provider adapter builds its request
 * turns field by field. It survives a restart (serializeSession writes the
 * whole message) and compaction (which keeps or spreads the turns it keeps).
 */
export type SystemTurn = UserMessage & { readonly systemTurn: true };

/** Push `content` as a {@link SystemTurn}. Every gate and replan prompt goes through here. */
export function pushSystemTurn(messages: { push(turn: SystemTurn): unknown }, content: string): void {
  const turn: SystemTurn = { role: "user", content, systemTurn: true };
  messages.push(turn);
}

/** A turn written by {@link pushSystemTurn}. */
export function isSystemTurn(message: ConversationMessage): boolean {
  return message.role === "user" && (message as Partial<SystemTurn>).systemTurn === true;
}
