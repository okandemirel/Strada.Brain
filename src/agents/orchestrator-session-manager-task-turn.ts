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

/**
 * A user-role turn the system writes for the model: a gate (loop recovery, a
 * verifier, clarification or visibility intervention, the max-tokens
 * continuation) or the replan prompt. The model reads it like any user turn;
 * the read of what the user last said passes over it (personsContent), and the
 * normalizer never folds it into a tool answer, where it would lose the mark.
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

/** Index of the run's task: the newest {@link TaskTurn}, or -1 when the history holds none. */
export function lastTaskTurnIndex(messages: readonly ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTaskTurn(messages[i]!)) return i;
  }
  return -1;
}

/**
 * The history of a fresh per-run session (Orchestrator.buildFreshRunSession): it opens on the
 * run's request as a {@link TaskTurn}, in the model's history and the visible transcript alike.
 */
export function freshRunSession(content: string | MessageContent[]): {
  messages: ConversationMessage[];
  visibleMessages: ConversationMessage[];
  lastActivity: Date;
} {
  const turn = taskTurn(content);
  return { messages: [turn], visibleMessages: [turn], lastActivity: new Date() };
}
