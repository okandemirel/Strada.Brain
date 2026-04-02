/**
 * Session Compaction Pipeline — 4-stage reducer for conversation history tokens.
 * Prevents O(N²) token growth. Stages run in order, stopping when within budget:
 *   1. Tool Result Compaction — shorten old tool results to one-line summaries
 *   2. Summarization — replace oldest groups with extractive summary
 *   3. Sliding Window — keep only the last N message groups
 *   4. Hard Truncation — emergency newest-first budget fill
 *
 * Note: The project's ConversationMessage type (UserMessage | AssistantMessage)
 * does not include a "system" role. This module uses a broader CompactableMessage
 * type internally to support injecting summary messages. The orchestrator's
 * session.messages array can contain system-role messages at runtime even though
 * the nominal type doesn't express it — hence the type cast in maybeCompactSession.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Trigger compaction when tokens exceed this fraction of context window. */
export const COMPACTION_TRIGGER_RATIO = 0.7;
/** Target token budget as a fraction of context window after compaction. */
export const COMPACTION_TARGET_RATIO = 0.6;
/** Fallback context window when provider capabilities are unavailable. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Max chars for the extractive summary in stage 2 (~800 tokens). */
const SUMMARY_MAX_CHARS = 3200;

// =============================================================================
// TYPES — broader than provider-core's ConversationMessage to support summaries
// =============================================================================

/** Content block types that appear in message content arrays. */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string | readonly ContentBlock[]; readonly is_error?: boolean };

/**
 * Superset of the project's ConversationMessage that also allows "system" role
 * for compaction-generated summary messages.
 */
export interface CompactableMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string | readonly ContentBlock[];
  readonly [key: string]: unknown;
}

export type MessageGroupKind = "system" | "user" | "assistant_text" | "tool_call";

export interface MessageGroup {
  readonly kind: MessageGroupKind;
  readonly messages: CompactableMessage[];
}

export interface CompactionOptions {
  /** Target token budget (e.g. contextWindow * COMPACTION_TARGET_RATIO). */
  readonly maxTokens: number;
  /** Number of recent groups to always preserve. Default: 4. */
  readonly preserveRecent?: number;
  /** Maximum groups for sliding window stage. Default: 20. */
  readonly maxGroups?: number;
}

export interface CompactionResult {
  readonly messages: CompactableMessage[];
  readonly compacted: boolean;
  readonly stageApplied: string | null;
  readonly originalTokens: number;
  readonly finalTokens: number;
}

// =============================================================================
// TOKEN ESTIMATION — delegates to CJK-aware heuristic from rag.interface
// =============================================================================

function contentBlockChars(block: ContentBlock): number {
  switch (block.type) {
    case "text": return block.text.length;
    case "tool_use": return block.name.length + JSON.stringify(block.input).length;
    case "tool_result": {
      if (typeof block.content === "string") return block.content.length;
      let sum = 0;
      for (const b of block.content) sum += contentBlockChars(b);
      return sum;
    }
  }
}

/** Character count for a single message (used for per-message cost in stage 4). */
function messageChars(msg: CompactableMessage): number {
  if (typeof msg.content === "string") return msg.content.length;
  let sum = 0;
  for (const block of msg.content) sum += contentBlockChars(block as ContentBlock);
  return sum;
}

/**
 * Estimate tokens for a message array.
 * Uses a direct chars/4 heuristic rather than allocating a synthetic string —
 * this runs on every PAOR iteration so memory efficiency matters.
 */
export function estimateTokens(
  messages: readonly CompactableMessage[],
  systemPromptChars = 0,
): number {
  if (messages.length === 0 && systemPromptChars === 0) return 0;
  let totalChars = systemPromptChars;
  for (const msg of messages) totalChars += messageChars(msg);
  if (totalChars === 0) return 0;
  return Math.ceil(totalChars / 4);
}

// =============================================================================
// MESSAGE GROUPING
// =============================================================================

function hasToolUse(msg: CompactableMessage): boolean {
  if (typeof msg.content === "string") return false;
  return (msg.content as readonly ContentBlock[]).some((b) => b.type === "tool_use");
}

function isToolResultMessage(msg: CompactableMessage): boolean {
  if (typeof msg.content === "string") return false;
  return (msg.content as readonly ContentBlock[]).every((b) => b.type === "tool_result");
}

/**
 * Groups a flat message array into atomic units:
 * `system`, `user`, `assistant_text`, or `tool_call` (assistant + subsequent tool_results).
 */
export function groupMessages(messages: readonly CompactableMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "system") { groups.push({ kind: "system", messages: [msg] }); i++; continue; }
    if (msg.role === "user") { groups.push({ kind: "user", messages: [msg] }); i++; continue; }
    if (msg.role === "assistant" && hasToolUse(msg)) {
      const batch: CompactableMessage[] = [msg];
      i++;
      while (i < messages.length && isToolResultMessage(messages[i]!)) { batch.push(messages[i]!); i++; }
      groups.push({ kind: "tool_call", messages: batch });
      continue;
    }
    groups.push({ kind: "assistant_text", messages: [msg] }); i++;
  }
  return groups;
}

// =============================================================================
// STAGE 1: Tool Result Compaction
// =============================================================================

function stage1ToolResultCompaction(groups: MessageGroup[]): MessageGroup[] {
  let count = 0;
  const recent = new Set<number>();
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]!.kind === "tool_call" && ++count <= 2) recent.add(i);
  }
  return groups.map((g, idx) => {
    if (g.kind !== "tool_call" || recent.has(idx)) return g;
    return { kind: g.kind, messages: compactToolGroup(g.messages) };
  });
}

function compactToolGroup(messages: readonly CompactableMessage[]): CompactableMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    const blocks = (msg.content as readonly ContentBlock[]).map((block): ContentBlock => {
      if (block.type === "tool_result") return { type: "text", text: `[tool ${block.tool_use_id}: ${block.is_error ? "FAIL" : "OK"}]` };
      if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: "[compacted]" as unknown };
      return block;
    });
    return { ...msg, content: blocks };
  });
}

// =============================================================================
// STAGE 2: Summarization
// =============================================================================

function stage2Summarization(groups: MessageGroup[], preserveRecent: number): MessageGroup[] {
  const sys = groups.filter((g) => g.kind === "system");
  const rest = groups.filter((g) => g.kind !== "system");
  if (rest.length <= preserveRecent) return groups;

  const toSummarize = rest.slice(0, rest.length - preserveRecent);
  const toKeep = rest.slice(rest.length - preserveRecent);
  const lines: string[] = [];
  let firstUser: string | null = null;

  for (const group of toSummarize) {
    for (const msg of group.messages) {
      const text = extractText(msg);
      if (!firstUser && msg.role === "user") { firstUser = text; continue; }
      const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
      lines.push(`- ${msg.role}: ${preview}`);
    }
  }

  const msgCount = toSummarize.reduce((s, g) => s + g.messages.length, 0);
  let summary = `[Compacted conversation summary \u2014 ${msgCount} messages removed]\n`;
  if (firstUser) {
    summary += `\nOriginal user request:\n${firstUser.length > 800 ? firstUser.slice(0, 800) + "..." : firstUser}\n`;
  }
  const budget = SUMMARY_MAX_CHARS - summary.length;
  if (budget > 0 && lines.length > 0) {
    let used = 0;
    const picked: string[] = [];
    for (const line of lines) {
      if (used + line.length + 1 > budget) break;
      picked.push(line);
      used += line.length + 1;
    }
    if (picked.length > 0) summary += `\nConversation flow:\n${picked.join("\n")}`;
  }

  const summaryMsg: CompactableMessage = { role: "system", content: summary };
  return [...sys, { kind: "system" as const, messages: [summaryMsg] }, ...toKeep];
}

function extractText(msg: CompactableMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return (msg.content as readonly ContentBlock[])
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `[tool: ${b.name}]`;
      return "[tool_result]";
    })
    .join(" ");
}

// =============================================================================
// STAGE 3: Sliding Window
// =============================================================================

function stage3SlidingWindow(groups: MessageGroup[], maxGroups: number): MessageGroup[] {
  const sys = groups.filter((g) => g.kind === "system");
  const rest = groups.filter((g) => g.kind !== "system");
  if (rest.length <= maxGroups) return groups;
  return [...sys, ...rest.slice(rest.length - maxGroups)];
}

// =============================================================================
// STAGE 4: Hard Truncation (emergency backstop)
// =============================================================================

function stage4HardTruncation(messages: readonly CompactableMessage[], maxTokens: number): CompactableMessage[] {
  const sys: CompactableMessage[] = [];
  const rest: CompactableMessage[] = [];
  for (const msg of messages) { (msg.role === "system" ? sys : rest).push(msg); }

  let budget = maxTokens - estimateTokens(sys);
  if (budget <= 0) return sys;

  const kept: CompactableMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = Math.ceil(messageChars(rest[i]!) / 4);
    if (cost > budget) continue; // skip oversized messages, keep smaller ones
    kept.unshift(rest[i]!);
    budget -= cost;
  }
  return [...sys, ...kept];
}

// =============================================================================
// PIPELINE
// =============================================================================

function flattenGroups(groups: readonly MessageGroup[]): CompactableMessage[] {
  return groups.flatMap((g) => g.messages);
}

/**
 * Runs the 4-stage compaction pipeline on a conversation, stopping as soon
 * as total tokens are within the given budget.
 */
export function compactSession(
  messages: readonly CompactableMessage[],
  options: CompactionOptions,
): CompactionResult {
  const { maxTokens, preserveRecent = 4, maxGroups = 20 } = options;
  const originalTokens = estimateTokens(messages);

  if (originalTokens <= maxTokens) {
    return { messages: [...messages], compacted: false, stageApplied: null, originalTokens, finalTokens: originalTokens };
  }

  let groups = groupMessages(messages);
  const check = (stage: string): CompactionResult | null => {
    const flat = flattenGroups(groups);
    const tokens = estimateTokens(flat);
    return tokens <= maxTokens ? { messages: flat, compacted: true, stageApplied: stage, originalTokens, finalTokens: tokens } : null;
  };

  groups = stage1ToolResultCompaction(groups);
  let result = check("tool_result_compaction");
  if (result) return result;

  groups = stage2Summarization(groups, preserveRecent);
  result = check("summarization");
  if (result) return result;

  groups = stage3SlidingWindow(groups, maxGroups);
  result = check("sliding_window");
  if (result) return result;

  const flat = stage4HardTruncation(flattenGroups(groups), maxTokens);
  const finalTokens = estimateTokens(flat);
  return { messages: flat, compacted: true, stageApplied: "hard_truncation", originalTokens, finalTokens };
}
