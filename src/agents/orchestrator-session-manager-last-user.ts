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
 */

import { INTERRUPTED_TOOL_RESULT } from "./conversation-normalizer.js";
import type { ConversationMessage } from "./providers/provider-core.interface.js";

/** A user turn carrying at least one recorded tool result: its text is the system's. */
export function isSystemToolResultTurn(msg: ConversationMessage): boolean {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b.type === "tool_result" && b.content !== INTERRUPTED_TOOL_RESULT);
}
