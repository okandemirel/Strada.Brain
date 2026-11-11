/**
 * Task turns: the user-role turns a person (or the run's request) wrote, kept
 * apart from the user-role turns the loop writes itself (tool results, gates,
 * provider-failure notices, recalls).
 */

import type { ConversationMessage, MessageContent, UserMessage } from "./providers/provider-core.interface.js";

/**
 * A user turn that sets what the run is for: what the person typed, or a
 * background run's request. The newest one in a history is the run's task, and
 * the history trim keeps it (orchestrator-session-manager-trim.ts): a cut by
 * position alone made a later plain-text gate, or an older chat turn, the head.
 *
 * The mark is a field, not text, so nothing has to be recognised by wording. It
 * stays off the wire: every provider adapter builds its request turns field by
 * field. It survives a restart (serializeSession writes the whole message) and
 * compaction (which keeps or spreads the turns it keeps).
 */
export type TaskTurn = UserMessage & { readonly taskTurn: true };

/** Build a {@link TaskTurn}. Every turn a person or a run request writes is made here. */
export function taskTurn(content: string | MessageContent[]): TaskTurn {
  return { role: "user", content, taskTurn: true };
}

/** A turn made by {@link taskTurn}. */
export function isTaskTurn(message: ConversationMessage): boolean {
  return message.role === "user" && (message as Partial<TaskTurn>).taskTurn === true;
}

/** Index of the run's task: the newest {@link TaskTurn}, or -1 when the history holds none. */
export function lastTaskTurnIndex(messages: readonly ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTaskTurn(messages[i]!)) return i;
  }
  return -1;
}
