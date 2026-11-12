/**
 * Which user-role turns hold the system's text rather than the user's words.
 *
 * After a tool batch the tool turn pushes a user-role turn: the tool results, then gate notes,
 * the plan-state injection and, in the reflection phase, the reflection prompt
 * (buildToolResultContentBlocks). Its text is the system's, and the session manager's
 * last-user-message read passes over it (SessionManager.extractLastUserMessage).
 *
 * One tool-result turn is not the system's: a call that never answered is answered by
 * normalizeConversation, which folds the user message after it into the answer behind
 * INTERRUPTED_TOOL_RESULT placeholders (conversation-normalizer.ts answerFor). Every result of
 * such a turn is a placeholder, and its text is what the user said next.
 *
 * The system also writes plain-text user turns: the gates and the replan prompt. Those are
 * marked where they are pushed (pushSystemTurn below).
 */

import { INTERRUPTED_TOOL_RESULT } from "./conversation-normalizer.js";
import type { ConversationMessage, UserMessage } from "./providers/provider-core.interface.js";

/** A user turn carrying at least one recorded tool result: its text is the system's. */
export function isSystemToolResultTurn(msg: ConversationMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b.type === "tool_result" && b.content !== INTERRUPTED_TOOL_RESULT);
}

/**
 * A user-role turn the system writes for the model: a gate (loop recovery, a
 * verifier, clarification or visibility intervention, the max-tokens
 * continuation) or the replan prompt. The model reads it like any user turn;
 * the reads of what the user last said pass over it (extractLastUserMessage).
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
