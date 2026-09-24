import type { ConversationMessage, MessageContent } from "./provider-core.interface.js";

type ToolResultBlock = Extract<MessageContent, { type: "tool_result" }>;

/** Said in place of a result that never reached the conversation. */
const MISSING_RESULT = "[no result was recorded for this tool call — it was interrupted before it answered]";

/** A result whose call is gone, kept as text so nothing the tool found is lost. */
function orphanAsText(block: ToolResultBlock): MessageContent {
  // Typed as a string, but the wire builders tolerate structured content too.
  const said = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
  return {
    type: "text",
    text: `[Result of an earlier tool call (${block.tool_use_id}) whose request is no longer in this conversation]\n${said}`,
  };
}

/**
 * Every assistant tool call answered by the user turn right after it, and no
 * result without its call — on the provider-neutral history.
 *
 * The chat-completions adapters already repair their wire messages
 * (openai.ts repairToolCallPairing). Claude, the Codex `/responses` input and
 * Ollama forwarded the history as-is, so a session that had lost a result (a
 * run aborted mid-tool, a compaction dropped it, a stream died between call
 * and answer) was rejected on every replay — "tool_use ids were found without
 * tool_result blocks", "No tool output found for function call" — and stayed
 * poisoned for those providers. A missing result becomes an error result that
 * says so; an orphaned one is folded into the turn as text. Results come
 * first in their user turn, in call order, as Anthropic requires.
 */
export function repairConversationToolPairing(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      // Not the answer to a tool-call turn (that case is consumed below), so
      // any result in it has no call to belong to.
      out.push(foldOrphanResults(msg));
      continue;
    }
    out.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) continue;

    const next = messages[i + 1];
    const nextBlocks: MessageContent[] = next?.role !== "user"
      ? []
      : typeof next.content === "string"
        ? (next.content ? [{ type: "text", text: next.content }] : [])
        : [...next.content];
    if (next?.role === "user") i++;

    const expected = new Set(calls.map((c) => c.id));
    const answered = new Map<string, ToolResultBlock>();
    const rest: MessageContent[] = [];
    for (const block of nextBlocks) {
      if (block.type !== "tool_result") {
        rest.push(block);
      } else if (expected.has(block.tool_use_id) && !answered.has(block.tool_use_id)) {
        answered.set(block.tool_use_id, block);
      } else {
        rest.push(orphanAsText(block));
      }
    }
    const results: MessageContent[] = calls.map((c) =>
      answered.get(c.id) ?? { type: "tool_result", tool_use_id: c.id, content: MISSING_RESULT, is_error: true });
    out.push({ role: "user", content: [...results, ...rest] });
  }
  return out;
}

function foldOrphanResults(msg: Extract<ConversationMessage, { role: "user" }>): ConversationMessage {
  if (typeof msg.content === "string" || !msg.content.some((b) => b.type === "tool_result")) return msg;
  return {
    ...msg,
    content: msg.content.map((b) => (b.type === "tool_result" ? orphanAsText(b) : b)),
  };
}
