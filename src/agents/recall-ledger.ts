/**
 * The recall ledger: what a run's memory refreshes recalled, kept so that it
 * reaches every model call of the run, and kept out of what memory stores.
 *
 * A refresh appends what it recalled to the history, once, instead of
 * rewriting the system prompt (turn-context.ts explains why). The history is
 * not permanent: every step trims it to the provider's message cap
 * (trimContextWindowForRun, 40 messages for a 128k model) and compaction
 * summarizes its older turns away. The refresher never recalls the same
 * content twice (it dedups against everything it injected), so a recall that
 * fell out of the history was gone for the rest of the run. In the system
 * prompt it had stayed until the run ended.
 *
 * So each recall carries a marker with the run's token and its number, and
 * after every step's trim and compaction the ledger appends the ones the
 * history no longer holds to the turn about to be sent. The compaction before
 * the retry after a hard timeout has no ledger at hand; it carries the recalls
 * it summarized away from the history itself (keepRecalls). A trim or a
 * compaction has just rewritten the head of the history, so the provider's
 * prefix cache misses at that call anyway; the restore costs nothing extra
 * there.
 *
 * The same markers keep the recall out of two readers that take the history
 * for something else. Memory leaves it out when it stores a trimmed
 * conversation (withoutRecalledMemory): a recall is what memory already held,
 * and storing it again as conversation would bring it back on a later run
 * under a new content hash. And it is not what the user last said: the recall
 * rides on a tool-result turn, which the session manager's last-user-message
 * reads (the shell reviewer's task, the end-turn prompt) used to return as the
 * user's words (SessionManager.extractLastUserContent).
 */

import { randomUUID } from "node:crypto";
import {
  hasToolCalls,
  type ConversationMessage,
  type MessageContent,
} from "./providers/provider-core.interface.js";
import { appendToLastUserTurn } from "./turn-context.js";

/**
 * What the ledger keeps for restoring, in characters. The system-prompt
 * sections it replaces held up to 12k of recalled memory and 12k of recalled
 * code context. Past it the oldest recalls are no longer restored.
 */
export const RECALL_LEDGER_MAX_CHARS = 24_000;

const START = "<!-- strada:recall ";
const END = "<!-- /strada:recall ";
const CLOSE = " -->";

/**
 * A marked recall, its key captured: from its start marker to its end marker,
 * or to the end of the text when compaction cut it.
 */
const MARKED_RECALL = /\n*<!-- strada:recall ([^\s>]+) -->[\s\S]*?(?:<!-- \/strada:recall [^\s>]+ -->|$)/g;

interface Recall {
  readonly key: string;
  readonly block: string;
}

/** Every text the model reads in `messages`: string contents and text blocks. */
function textsOf(messages: readonly ConversationMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content as MessageContent[]) if (block.type === "text") texts.push(block.text);
    }
  }
  return texts;
}

/**
 * Put `text` at the end of the history: on its last user turn, or as a user
 * turn of its own when the history is empty (a trim at the hard cap can leave
 * nothing that may start a conversation) or ends on an assistant turn that
 * awaits no tool result. False, and nothing changed, otherwise.
 */
function appendToHistory(messages: ConversationMessage[], text: string): boolean {
  if (appendToLastUserTurn(messages, text)) return true;
  const last = messages.at(-1);
  if (last && (last.role !== "assistant" || hasToolCalls(last))) return false;
  messages.push({ role: "user", content: text });
  return true;
}

/**
 * Append to the end of `messages` each of `recalls` it no longer holds, oldest
 * first. A recall compaction shortened still counts as held: compaction cut it
 * to fit the window. Returns how many it put back; 0 when none was missing or
 * the history ends on a turn that awaits a tool result.
 */
function appendMissing(messages: ConversationMessage[], recalls: readonly Recall[]): number {
  if (recalls.length === 0) return 0;
  const held = textsOf(messages).join("\n");
  const missing = recalls.filter((r) => !held.includes(`${START}${r.key}${CLOSE}`));
  if (missing.length === 0) return 0;
  return appendToHistory(messages, missing.map((r) => r.block).join("\n\n")) ? missing.length : 0;
}

export class RecallLedger {
  private readonly runToken = randomUUID().slice(0, 8);
  private count = 0;
  private recalls: Recall[] = [];

  constructor(private readonly maxChars = RECALL_LEDGER_MAX_CHARS) {}

  /**
   * Mark `recall`, keep it, and append it to the end of `messages` (the turn
   * the loop is about to send). When it cannot go there, the next restore
   * puts it in.
   */
  add(messages: ConversationMessage[], recall: string): void {
    const key = `${this.runToken}#${++this.count}`;
    const block = `${START}${key}${CLOSE}\n${recall}\n${END}${key}${CLOSE}`;
    this.recalls.push({ key, block });
    let total = this.recalls.reduce((chars, r) => chars + r.block.length, 0);
    while (this.recalls.length > 1 && total > this.maxChars) total -= this.recalls.shift()!.block.length;
    appendToHistory(messages, block);
  }

  /**
   * Append to the end of `messages` every kept recall it no longer holds
   * (appendMissing). Returns how many it restored; when it could not, the next
   * step tries again.
   */
  restore(messages: ConversationMessage[]): number {
    return appendMissing(messages, this.recalls);
  }
}

/**
 * Put back on the end of `compacted` every marked recall `history` held and
 * `compacted` no longer does (appendMissing), for a compaction run where the
 * run's ledger is not at hand: the retry after a hard timeout
 * (orchestrator.ts compactSessionAfterHardTimeout). Returns how many it put
 * back.
 */
export function keepRecalls(history: readonly ConversationMessage[], compacted: ConversationMessage[]): number {
  const recalls = new Map<string, Recall>();
  for (const text of textsOf(history)) {
    for (const match of text.matchAll(MARKED_RECALL)) {
      const key = match[1]!;
      const end = `${END}${key}${CLOSE}`;
      // A recall an earlier compaction cut is closed again, so it does not run on into what follows it.
      const block = match[0].trimStart();
      recalls.set(key, { key, block: block.endsWith(end) ? block : `${block}\n${end}` });
    }
  }
  return appendMissing(compacted, [...recalls.values()]);
}

/** `text` without its marked recalls. */
function stripRecalls(text: string): string {
  return text.includes(START) ? text.replace(MARKED_RECALL, "") : text;
}

/**
 * `messages` with every marked recall taken out, for what memory stores and
 * for what the user last said. A text block left empty is dropped. `messages`
 * itself is never changed, and a message without a recall is returned as is.
 */
export function withoutRecalledMemory(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      const content = stripRecalls(message.content);
      return content === message.content ? message : ({ ...message, content } as ConversationMessage);
    }
    if (!Array.isArray(message.content)) return message;
    const blocks = message.content as MessageContent[];
    if (!blocks.some((b) => b.type === "text" && b.text.includes(START))) return message;
    const kept = blocks
      .map((b) => (b.type === "text" ? { ...b, text: stripRecalls(b.text) } : b))
      .filter((b) => b.type !== "text" || b.text.trim().length > 0);
    return { ...message, content: kept } as ConversationMessage;
  });
}
