/**
 * The one conversation shape every provider accepts, enforced right before each provider call.
 *
 * The tool-pairing contract had no single owner: the loop, compaction and persistence each broke
 * `assistant(tool_calls)` → `user(tool_result…)` in a different way (a throw between the two, gate
 * text inserted between them, a cut through a pair), and only the OpenAI adapter repaired it.
 * Anthropic rejects every one of those shapes with a 400, and sessions persist, so one bad turn
 * poisoned the chat until it expired. This pass runs on the session before each call, for every
 * provider, and fixes the session in place so the repair also outlives the turn:
 *
 *  1. every assistant tool call is answered by the next user message, whose LEADING blocks are
 *     the tool_result blocks in call order — a result that sits later (behind gate text, in a
 *     following user message) is moved up; a result that never arrived is recorded as such;
 *  2. a tool_result with no matching call right before it becomes plain text (nothing it said is
 *     lost, and the shape is legal);
 *  3. an assistant turn with no text and no tool calls is dropped (Anthropic rejects it);
 *  4. the conversation starts with a user turn.
 *
 * Returns the SAME array when nothing needed fixing, so callers can tell a repair happened.
 */

import type { ConversationMessage, MessageContent, ToolCall } from "./providers/provider-core.interface.js";

type ToolResultBlock = Extract<MessageContent, { type: "tool_result" }>;

/** The OpenAI adapter's wording (openai.ts repairToolCallPairing), so the model reads one phrasing. */
export const INTERRUPTED_TOOL_RESULT = "[no result was recorded for this tool call — it was interrupted before it answered]";
export const COMPACTED_HEAD_NOTE = "[Earlier turns of this conversation are no longer included.]";

function orphanAsText(block: ToolResultBlock): MessageContent {
  return {
    type: "text",
    text: `[Result of an earlier tool call (${block.tool_use_id}) whose request is no longer in this conversation]\n${block.content}`,
  };
}

function blocksOf(content: string | MessageContent[]): MessageContent[] {
  if (typeof content !== "string") return content;
  return content.length > 0 ? [{ type: "text", text: content }] : [];
}

function isBlankAssistant(msg: ConversationMessage): boolean {
  if (msg.role !== "assistant" || msg.tool_calls?.length) return false;
  // Typed as a string, but a worker answer can arrive as blocks at runtime.
  const content: unknown = msg.content;
  return typeof content === "string" ? content.trim().length === 0 : Array.isArray(content) && content.length === 0;
}

/** The next message already answers `calls` exactly, results first — keep it untouched. */
function answersCalls(msg: ConversationMessage | undefined, calls: readonly ToolCall[]): boolean {
  if (!msg || msg.role !== "user" || typeof msg.content === "string") return false;
  const ids = new Set(calls.map((c) => c.id));
  const results = msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
  if (results.length !== ids.size) return false;
  const leading = msg.content.slice(0, ids.size);
  return leading.every((b) => b.type === "tool_result" && ids.has(b.tool_use_id))
    && new Set(results.map((b) => b.tool_use_id)).size === ids.size;
}

/** A user message outside a tool exchange must carry no tool_result blocks. */
function withoutOrphans(msg: ConversationMessage): ConversationMessage {
  if (msg.role !== "user" || typeof msg.content === "string") return msg;
  if (!msg.content.some((b) => b.type === "tool_result")) return msg;
  return { role: "user", content: msg.content.map((b) => (b.type === "tool_result" ? orphanAsText(b) : b)) };
}

/**
 * Build the answer to `calls` from the user messages that follow the assistant turn. Every
 * follower up to the last one holding one of these results is folded in (at least the first,
 * when there is one); later followers stay separate messages.
 */
function answerFor(calls: readonly ToolCall[], followers: readonly ConversationMessage[]): {
  answer: ConversationMessage;
  consumed: number;
} {
  const ids = new Set(calls.map((c) => c.id));
  let lastWithResult = -1;
  followers.forEach((f, idx) => {
    if (typeof f.content !== "string" && f.content.some((b) => b.type === "tool_result" && ids.has(b.tool_use_id))) {
      lastWithResult = idx;
    }
  });
  const consumed = Math.max(lastWithResult + 1, followers.length > 0 ? 1 : 0);
  const found = new Map<string, ToolResultBlock>();
  const rest: MessageContent[] = [];
  for (const f of followers.slice(0, consumed)) {
    for (const block of blocksOf(f.content)) {
      if (block.type !== "tool_result") rest.push(block);
      else if (ids.has(block.tool_use_id) && !found.has(block.tool_use_id)) found.set(block.tool_use_id, block);
      else rest.push(orphanAsText(block));
    }
  }
  const results: MessageContent[] = [...ids].map(
    (id) => found.get(id) ?? { type: "tool_result", tool_use_id: id, content: INTERRUPTED_TOOL_RESULT, is_error: true },
  );
  return { answer: { role: "user", content: [...results, ...rest] }, consumed };
}

export function normalizeConversation(messages: ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      const clean = withoutOrphans(msg);
      if (clean !== msg) changed = true;
      out.push(clean);
      i++;
      continue;
    }
    if (isBlankAssistant(msg)) {
      changed = true;
      i++;
      continue;
    }
    out.push(msg);
    i++;
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) continue;
    if (answersCalls(messages[i], calls)) {
      out.push(messages[i]!);
      i++;
      continue;
    }
    let end = i;
    while (end < messages.length && messages[end]!.role === "user") end++;
    const { answer, consumed } = answerFor(calls, messages.slice(i, end));
    out.push(answer);
    changed = true;
    i += consumed;
  }
  if (out.length > 0 && out[0]!.role !== "user") {
    // Losing the assistant turn would lose what it did; a note in front keeps the shape legal.
    out.unshift({ role: "user", content: COMPACTED_HEAD_NOTE });
    changed = true;
  }
  return changed ? out : messages;
}
