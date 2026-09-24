/**
 * Session Compaction Pipeline — 4-stage reducer for conversation history tokens.
 * Prevents O(N²) token growth. Stages run in order, stopping when within budget:
 *   1. Tool Result Compaction — shorten old tool results to one-line summaries
 *   2. Summarization — replace oldest groups with extractive summary
 *   3. Sliding Window — keep only the last N message groups
 *   4. Hard Truncation — emergency newest-first budget fill
 *
 * Note: The project's ConversationMessage type (UserMessage | AssistantMessage)
 * does not include a "system" role. The pipeline internally represents summary
 * text as SystemSummaryMessage entries, but they never leak out: compactSession
 * partitions them off and returns them as CompactionResult.summary, which the
 * orchestrator stores in Session.compactionSummary and appends to the system
 * prompt at provider call time.
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

/**
 * Hard cap for the rolling compaction summary that accumulates across cycles.
 *
 * Each stage-2 compaction APPENDS a fresh ~SUMMARY_MAX_CHARS (3200-char) summary
 * and KEEPS the previous one, so without a cap the rolling summary grows ~3.2KB
 * per compaction until it alone exceeds the model budget — at which point stage 4
 * drops all conversation and compaction thrashes on every provider call.
 *
 * 12000 chars ≈ 3000 tokens (chars/4). That holds ~3-4 stacked stage-2 summaries
 * (head = original-request header + oldest flow, tail = most recent flow) and stays
 * comfortably under even the smallest realistic post-compaction budget
 * (DEFAULT_CONTEXT_WINDOW 128k × COMPACTION_TARGET_RATIO 0.6 ≈ 76k tokens; an 8k
 * model still yields ~4800 tokens of budget), so the summary never starves the
 * conversation. The cap is enforced head+tail so the "Original user request"
 * header (always first) and the newest summary detail (most relevant) both survive.
 */
export const MAX_ROLLING_SUMMARY_CHARS = 12000;

/** Middle-elision marker inserted when a rolling summary is head+tail truncated. */
const SUMMARY_TRUNCATION_MARKER = "\n\n[... older summary detail truncated ...]\n\n";

/**
 * Truncate an over-long rolling summary while preserving BOTH ends:
 * the head (carries the "Original user request" header emitted first by stage 2)
 * and the tail (the most recent, most relevant summary). The dropped middle is
 * replaced with {@link SUMMARY_TRUNCATION_MARKER}. Returns the input unchanged
 * when it already fits within {@link MAX_ROLLING_SUMMARY_CHARS}.
 *
 * This is the single choke point for rolling-summary growth — both the live
 * compaction path (via {@link partitionSummary}) and the disk-restore path route
 * through it, so the cap cannot be bypassed.
 */
export function capRollingSummary(summary: string): string {
  if (summary.length <= MAX_ROLLING_SUMMARY_CHARS) return summary;
  const budget = MAX_ROLLING_SUMMARY_CHARS - SUMMARY_TRUNCATION_MARKER.length;
  if (budget <= 0) return summary.slice(0, MAX_ROLLING_SUMMARY_CHARS);
  // Bias toward the tail (most recent) but keep a substantial head for the
  // original-request header: ~40% head, ~60% tail.
  const headChars = Math.floor(budget * 0.4);
  const tailChars = budget - headChars;
  return summary.slice(0, headChars) + SUMMARY_TRUNCATION_MARKER + summary.slice(summary.length - tailChars);
}

import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { createTokenBuckets, type TokenBuckets } from "../common/token-estimator.js";

// =============================================================================
// TYPES — broader than provider-core's ConversationMessage to support summaries
// =============================================================================

/** Content block types that appear in message content arrays. */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: unknown }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string | readonly ContentBlock[]; readonly is_error?: boolean };

/** The wire shape's tool calls: they ride beside an assistant's text, not inside it. */
type ToolCallLike = { readonly id: string; readonly name: string; readonly input: unknown };

function toolCallsOf(msg: CompactableMessage): readonly ToolCallLike[] {
  if (msg.role !== "assistant") return [];
  return (msg as { tool_calls?: readonly ToolCallLike[] }).tool_calls ?? [];
}

/** Internal summary message used by the compaction pipeline. */
export interface SystemSummaryMessage {
  readonly role: "system";
  readonly content: string;
}

/** Union the pipeline operates on internally. ConversationMessage[] is directly assignable. */
export type CompactableMessage = ConversationMessage | SystemSummaryMessage;

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
  /** Summary produced by a previous compaction; counted and merged into the new summary. */
  readonly previousSummary?: string;
}

export interface CompactionResult {
  /** Compacted conversation — guaranteed free of system-role entries. */
  readonly messages: ConversationMessage[];
  /** Merged summary text, if any system/summary content was produced. */
  readonly summary?: string;
  readonly compacted: boolean;
  readonly stageApplied: string | null;
  readonly originalTokens: number;
  readonly finalTokens: number;
}

// =============================================================================
// TOKEN ESTIMATION — delegates to CJK-aware heuristic from rag.interface
// =============================================================================

/**
 * Flat per-image cost. Providers bill an image by its pixels (Anthropic: w×h/750, about 1 600
 * tokens at the size they downscale to), never by its base64 length, which is not counted.
 */
const IMAGE_TOKEN_ESTIMATE = 1_600;
/** Latin characters per token in the shared estimator (the same rule toolSchemaTokens uses). */
const LATIN_CHARS_PER_TOKEN = 4;

function contentBlockIntoBuckets(block: ContentBlock, buckets: TokenBuckets): void {
  switch (block.type) {
    case "text": buckets.addText(block.text); return;
    case "image": buckets.addLatinChars(IMAGE_TOKEN_ESTIMATE * LATIN_CHARS_PER_TOKEN); return;
    case "tool_use": buckets.addText(block.name + JSON.stringify(block.input)); return;
    case "tool_result": {
      if (typeof block.content === "string") { buckets.addText(block.content); return; }
      for (const b of block.content) contentBlockIntoBuckets(b as ContentBlock, buckets);
      return;
    }
  }
}

/** Accumulate a single message's characters into the shared token buckets. */
function messageIntoBuckets(msg: CompactableMessage, buckets: TokenBuckets): void {
  if (typeof msg.content === "string") {
    buckets.addText(msg.content);
  } else {
    for (const block of msg.content) contentBlockIntoBuckets(block as ContentBlock, buckets);
  }
  // A file_write's whole file body is in its call's input. Uncounted, a session of large
  // writes estimated at a few dozen tokens and compaction never ran (ORC-3).
  for (const tc of toolCallsOf(msg)) buckets.addText(tc.name + JSON.stringify(tc.input ?? {}));
}

/**
 * Estimate tokens for a message array.
 *
 * Delegates to the SHARED estimator (src/common/token-estimator.ts) — the old
 * flat chars/4 under-counted CJK and symbol-dense tool-JSON text, firing
 * compaction late on exactly the heaviest sessions. Still zero-allocation:
 * characters are classified through bucket accumulation, never re-stringified.
 */
export function estimateTokens(
  messages: readonly CompactableMessage[],
  systemPromptChars = 0,
): number {
  if (messages.length === 0 && systemPromptChars === 0) return 0;
  const buckets = createTokenBuckets();
  buckets.addLatinChars(systemPromptChars); // system prompt is English — plain char count is its latin share
  for (const msg of messages) messageIntoBuckets(msg, buckets);
  return buckets.totalTokens();
}

// =============================================================================
// MESSAGE GROUPING
// =============================================================================

function hasToolUse(msg: CompactableMessage): boolean {
  if (toolCallsOf(msg).length > 0) return true;
  if (typeof msg.content === "string") return false;
  return (msg.content as readonly ContentBlock[]).some((b) => b.type === "tool_use");
}

/** A user turn that answers tool calls. It may carry gate or reflection text after the results. */
function isToolResultMessage(msg: CompactableMessage): boolean {
  if (msg.role !== "user" || typeof msg.content === "string") return false;
  return (msg.content as readonly ContentBlock[]).some((b) => b.type === "tool_result");
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
// ORPHAN TOOL-REFERENCE REPAIR
// =============================================================================

/**
 * Removes orphaned tool references from a compacted conversation so the result
 * can never produce an Anthropic 400 ("tool_use without tool_result" / vice versa).
 *
 * In this project's wire shape a tool call spans TWO messages: an assistant
 * message carries `tool_calls: [{ id, ... }]` (string content), and the matching
 * tool RESULT is a SEPARATE later user message whose content is tool_result
 * block(s) with `tool_use_id`. Stage-4 truncation can keep one side of a pair and
 * drop the other; this pass rebalances by tool id:
 *   - drops any user message whose content is ONLY tool_result block(s) when none
 *     of those tool_use_ids match a kept assistant tool_call id; and
 *   - strips an assistant message's tool_calls whose results are all absent
 *     (keeping the assistant's text so context is not lost).
 *
 * Provider-agnostic and minimal: the repair lives here (where compaction creates
 * the orphan), NOT in claude.ts buildMessages (which assumes paired tool blocks).
 */
export function dropOrphanToolMessages(messages: ConversationMessage[]): ConversationMessage[] {
  // Collect tool_result ids that survive (present in some user message).
  const presentResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content as readonly ContentBlock[]) {
      if (block.type === "tool_result") presentResultIds.add(block.tool_use_id);
    }
  }

  // Collect assistant tool_call ids that survive (so we can detect orphan results).
  const presentCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const calls = (msg as { tool_calls?: readonly { id: string }[] }).tool_calls;
    if (calls) for (const tc of calls) presentCallIds.add(tc.id);
  }

  const repaired: ConversationMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const calls = (msg as { tool_calls?: readonly { id: string }[] }).tool_calls;
      if (calls && calls.length > 0) {
        const keptCalls = calls.filter((tc) => presentResultIds.has(tc.id));
        if (keptCalls.length === calls.length) {
          repaired.push(msg);
        } else if (keptCalls.length > 0) {
          // Some results survived — keep only the paired calls.
          repaired.push({ ...(msg as object), tool_calls: keptCalls } as ConversationMessage);
        } else {
          // No paired result — drop tool_calls entirely, keep the text.
          const { tool_calls: _drop, ...rest } = msg as { tool_calls?: unknown };
          repaired.push(rest as ConversationMessage);
        }
        continue;
      }
      repaired.push(msg);
      continue;
    }

    // User message: if its content is ONLY tool_result blocks and none of them
    // reference a surviving tool_call, the whole message is an orphan — drop it.
    if (msg.role === "user" && typeof msg.content !== "string") {
      const blocks = msg.content as readonly ContentBlock[];
      const resultBlocks = blocks.filter((b) => b.type === "tool_result");
      if (resultBlocks.length > 0 && resultBlocks.length === blocks.length) {
        const keptBlocks = resultBlocks.filter((b) => presentCallIds.has((b as { tool_use_id: string }).tool_use_id));
        if (keptBlocks.length === 0) continue; // fully orphaned → drop
        if (keptBlocks.length < resultBlocks.length) {
          repaired.push({ role: "user", content: keptBlocks as unknown as ConversationMessage["content"] });
          continue;
        }
      }
    }
    repaired.push(msg);
  }
  return repaired;
}

/**
 * An assistant turn whose tool calls were all orphaned keeps only its text — often "". Anthropic
 * rejects a non-final message with empty content, and the compacted array is persisted.
 */
function dropEmptyAssistantTurns(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter(
    (m) => m.role !== "assistant" || (m.tool_calls?.length ?? 0) > 0 || String(m.content ?? "").trim().length > 0,
  );
}

/** Stands in for the turns a compaction cut away, so the conversation still opens with the user. */
export const COMPACTED_CONVERSATION_NOTE = "[Earlier turns were compacted; the summary is in the system prompt.]";

/**
 * The conversation must open with a user turn (trimSession's head rule). Summarization and the
 * sliding window keep the newest groups, which can start with an assistant turn; the dropped
 * turns live on in the summary, so a note stands in for them instead of dropping kept content.
 */
function repairHead(messages: ConversationMessage[]): ConversationMessage[] {
  if (messages.length === 0 || messages[0]!.role === "user") return messages;
  return [{ role: "user", content: COMPACTED_CONVERSATION_NOTE }, ...messages];
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

/** Kept verbatim at the head of a compacted tool result or tool-input string. */
const COMPACTED_PREVIEW_CHARS = 200;

function compactedText(text: string): string {
  if (text.length <= COMPACTED_PREVIEW_CHARS + 100) return text;
  return `${text.slice(0, COMPACTED_PREVIEW_CHARS)}… [compacted, ${text.length} chars]`;
}

/**
 * Shorten a tool call's input while keeping it an object — providers require tool_use input to
 * be one (the old "[compacted]" string was not). Long strings keep their head; large nested
 * values are replaced by a marker.
 */
function compactToolInput(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  if (JSON.stringify(input).length <= COMPACTED_PREVIEW_CHARS + 100) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = compactedText(value);
    else if (value !== null && typeof value === "object" && JSON.stringify(value).length > COMPACTED_PREVIEW_CHARS) out[key] = "[compacted]";
    else out[key] = value;
  }
  return out;
}

/**
 * Shorten an old tool group IN PLACE: the tool_use/tool_result blocks stay (so pairing survives
 * and the provider still sees what was called), their payloads shrink. Turning results into text
 * blocks, as this did, left the assistant's tool_calls unanswered.
 */
function compactToolGroup(messages: readonly CompactableMessage[]): CompactableMessage[] {
  return messages.map((msg) => {
    const calls = toolCallsOf(msg);
    const withCalls = calls.length > 0
      ? ({ ...msg, tool_calls: calls.map((tc) => ({ ...tc, input: compactToolInput(tc.input) })) } as CompactableMessage)
      : msg;
    if (typeof withCalls.content === "string") return withCalls;
    const blocks = (withCalls.content as readonly ContentBlock[]).map((block): ContentBlock => {
      if (block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return { ...block, content: compactedText(text) };
      }
      if (block.type === "tool_use") return { ...block, input: compactToolInput(block.input) };
      return block;
    });
    // Same-altitude cast as the content reads above: the runtime arrays carry
    // tool blocks that the nominal UserMessage/AssistantMessage content types
    // do not express.
    return { ...withCalls, content: blocks } as CompactableMessage;
  });
}

// =============================================================================
// STAGE 2: Summarization
// =============================================================================

function stage2Summarization(groups: MessageGroup[], preserveRecent: number): MessageGroup[] {
  const sys = groups.filter((g) => g.kind === "system");
  const rest = groups.filter((g) => g.kind !== "system");
  if (rest.length <= preserveRecent) return groups;

  // The newest user turn is what the run is answering: it stays verbatim even when more than
  // `preserveRecent` groups of work followed it (the summary keeps only a 100-char preview).
  const cut = rest.length - preserveRecent;
  const lastUser = newestUserGroup(rest);
  const toSummarize = rest.slice(0, cut).filter((_, i) => i !== lastUser);
  const toKeep = [...(lastUser >= 0 && lastUser < cut ? [rest[lastUser]!] : []), ...rest.slice(cut)];
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
  const cut = rest.length - maxGroups;
  const lastUser = newestUserGroup(rest);
  return [...sys, ...(lastUser >= 0 && lastUser < cut ? [rest[lastUser]!] : []), ...rest.slice(cut)];
}

/** Index of the newest group that is a user turn someone wrote (not an orphaned tool result). */
function newestUserGroup(groups: readonly MessageGroup[]): number {
  return findLastIndex(groups, (g) => g.kind === "user" && isRealUserTurn(g.messages[0]!));
}

// =============================================================================
// STAGE 4: Hard Truncation (emergency backstop)
// =============================================================================

function stage4HardTruncation(messages: readonly CompactableMessage[], maxTokens: number): CompactableMessage[] {
  let sys: CompactableMessage[] = [];
  const rest: CompactableMessage[] = [];
  for (const msg of messages) { (msg.role === "system" ? sys : rest).push(msg); }

  // Whole groups, newest first, so a tool call is never kept without its result (or vice versa).
  // The turn being answered — the newest user turn and the newest group — is always kept,
  // shortened if it has to be: skipping it as "oversized" (a pasted log, a big tool result)
  // left the model answering without the input it was given, or with no user turn at all (ORC-6).
  const groups = groupMessages(rest);
  const pinned = new Set<number>();
  if (groups.length > 0) pinned.add(groups.length - 1);
  const lastUser = newestUserGroup(groups);
  if (lastUser >= 0) pinned.add(lastUser);

  const sysTokens = estimateTokens(sys);
  const pinnedTokens = [...pinned].reduce((sum, idx) => sum + estimateTokens(groups[idx]!.messages), 0);
  // The pinned turns take what they need, or half the budget when the summary competes for it.
  const pinnedCap = sysTokens + pinnedTokens <= maxTokens ? maxTokens - sysTokens : Math.floor(maxTokens / 2);
  const keptGroups = new Map<number, CompactableMessage[]>();
  let pinnedUsed = 0;
  for (const idx of pinned) {
    const shrunk = shrinkToTokens(groups[idx]!.messages, Math.max(1, Math.floor(pinnedCap / pinned.size)));
    keptGroups.set(idx, shrunk);
    pinnedUsed += estimateTokens(shrunk);
  }

  let budget = maxTokens - pinnedUsed - sysTokens;
  if (budget < 0) {
    // Defensive: the (capped) summary overruns what the pinned turns leave. NEVER return an
    // over-budget prompt — hard-truncate the summary TEXT itself to fit. The char budget
    // (≈ 4 per token) is shared ACROSS all system messages (there may be more than one:
    // previous + freshly-appended summary), head-first. Reserve the "\n\n" join overhead
    // that partitionSummary later adds between summaries so the merged-and-measured result
    // stays within maxTokens.
    const systemCount = sys.filter((m) => m.role === "system").length;
    const joinOverhead = systemCount > 1 ? (systemCount - 1) * 2 : 0;
    let remainingChars = Math.max(0, (maxTokens - pinnedUsed) * 4 - joinOverhead);
    sys = sys.map((m): CompactableMessage => {
      if (m.role !== "system" || typeof m.content !== "string") return m;
      const take = Math.min(m.content.length, remainingChars);
      remainingChars -= take;
      return { role: "system", content: m.content.slice(0, take) };
    });
    budget = 0;
  }

  for (let i = groups.length - 1; i >= 0; i--) {
    if (pinned.has(i)) continue;
    const cost = estimateTokens(groups[i]!.messages);
    if (cost > budget) continue; // skip oversized groups, keep smaller ones
    keptGroups.set(i, groups[i]!.messages);
    budget -= cost;
  }
  const kept = [...keptGroups.entries()].sort((x, y) => x[0] - y[0]).flatMap(([, msgs]) => msgs);
  return [...sys.filter((m) => m.role !== "system" || String(m.content).length > 0), ...kept];
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

/** A user turn a person (or the task) wrote — not a tool result whose call is gone. */
function isRealUserTurn(msg: CompactableMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return msg.content.trim().length > 0;
  return (msg.content as readonly ContentBlock[]).some((b) => b.type !== "tool_result");
}

const TRUNCATION_MARKER = "\n[… truncated to fit the context window]";

function cutText(text: string, ratio: number): string {
  if (ratio >= 1) return text;
  const keep = Math.max(0, Math.floor(text.length * ratio) - TRUNCATION_MARKER.length);
  return keep >= text.length ? text : text.slice(0, keep) + TRUNCATION_MARKER;
}

/** Shorten every payload of a group by the same ratio (tool inputs to their compacted form). */
function shrinkGroup(messages: readonly CompactableMessage[], ratio: number): CompactableMessage[] {
  return messages.map((msg) => {
    const calls = toolCallsOf(msg);
    const base = calls.length > 0
      ? ({ ...msg, tool_calls: calls.map((tc) => ({ ...tc, input: compactToolInput(tc.input) })) } as CompactableMessage)
      : msg;
    if (typeof base.content === "string") return { ...base, content: cutText(base.content, ratio) } as CompactableMessage;
    const blocks = (base.content as readonly ContentBlock[]).map((b): ContentBlock => {
      if (b.type === "text") return { ...b, text: cutText(b.text, ratio) };
      if (b.type === "tool_result" && typeof b.content === "string") return { ...b, content: cutText(b.content, ratio) };
      return b;
    });
    return { ...base, content: blocks } as CompactableMessage;
  });
}

/** Shrink a group until it fits `maxTokens` (a few proportional passes, then a hard floor). */
function shrinkToTokens(messages: readonly CompactableMessage[], maxTokens: number): CompactableMessage[] {
  let current = [...messages];
  for (let pass = 0; pass < 4; pass++) {
    const cost = estimateTokens(current);
    if (cost <= maxTokens) return current;
    current = shrinkGroup(current, (maxTokens / cost) * 0.9);
  }
  return estimateTokens(current) <= maxTokens ? current : shrinkGroup(current, 0);
}

// =============================================================================
// PIPELINE
// =============================================================================

function flattenGroups(groups: readonly MessageGroup[]): CompactableMessage[] {
  return groups.flatMap((g) => g.messages);
}

/**
 * Splits a flat pipeline result into the system-free conversation and the
 * merged summary text extracted from system-role entries (front-positioned
 * by stages 2-4, so ordering is preserved by extraction).
 */
function partitionSummary(flat: readonly CompactableMessage[]): {
  messages: ConversationMessage[];
  summary: string | undefined;
} {
  // Drop any orphaned tool_use/tool_result references before partitioning so the
  // returned conversation can never trigger an Anthropic 400 (see dropOrphanToolMessages),
  // then repair what that can leave behind (ORC-6).
  const repaired = repairHead(dropEmptyAssistantTurns(dropOrphanToolMessages(
    flat.filter((m): m is ConversationMessage => m.role !== "system"),
  )));
  const summaries = flat
    .filter((m): m is SystemSummaryMessage => m.role === "system")
    .map((m) => m.content);
  // Cap the merged rolling summary here — the single choke point every live
  // compaction flows through — so it can never grow unbounded across cycles.
  const merged = summaries.length > 0 ? capRollingSummary(summaries.join("\n\n")) : undefined;
  return { messages: repaired, summary: merged };
}

/**
 * Runs the 4-stage compaction pipeline on a conversation, stopping as soon
 * as total tokens are within the given budget. The summary produced by a
 * previous compaction (options.previousSummary) is counted toward the budget
 * and merged into the newly returned summary.
 */
export function compactSession(
  messages: readonly ConversationMessage[],
  options: CompactionOptions,
): CompactionResult {
  const { maxTokens, preserveRecent = 4, maxGroups = 20 } = options;
  const working: CompactableMessage[] = options.previousSummary
    ? [{ role: "system", content: options.previousSummary }, ...messages]
    : [...messages];
  const originalTokens = estimateTokens(working);

  if (originalTokens <= maxTokens) {
    return {
      messages: [...messages],
      // Cap here too so the early-return path can never carry an over-cap summary
      // forward (defence in depth — restore + every compaction already cap).
      summary: options.previousSummary ? capRollingSummary(options.previousSummary) : undefined,
      compacted: false,
      stageApplied: null,
      originalTokens,
      finalTokens: originalTokens,
    };
  }

  let groups = groupMessages(working);
  const check = (stage: string): CompactionResult | null => {
    const flat = flattenGroups(groups);
    const tokens = estimateTokens(flat);
    if (tokens > maxTokens) return null;
    const { messages: rest, summary } = partitionSummary(flat);
    return { messages: rest, summary, compacted: true, stageApplied: stage, originalTokens, finalTokens: tokens };
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
  const { messages: rest, summary } = partitionSummary(flat);
  return { messages: rest, summary, compacted: true, stageApplied: "hard_truncation", originalTokens, finalTokens };
}

// ---------------------------------------------------------------------------
// Retry after a hard-timeout (2026-09-09)
//
// Measured 13:23-13:49 on the placeholder mission: a 57k-token turn hit the
// 10-minute call ceiling twice in a row with zero output, while the same
// model had been answering 41-47k turns in 20-55 s. The ordinary compaction
// only triggers at COMPACTION_TRIGGER_RATIO of the declared 128k window, far
// above where the free tier stops answering. When a call produces nothing for
// the whole ceiling, the retry gets a prompt half the size.
// ---------------------------------------------------------------------------

/** Floor for the retry target so a short conversation is not shredded. */
export const RETRY_COMPACTION_FLOOR_TOKENS = 8_000;

export function isHardTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /hard-timeout/.test(message);
}

/** Compact to half the current estimate (never below the floor), keeping the last two messages verbatim. */
export function compactForRetry(
  messages: readonly ConversationMessage[],
  previousSummary?: string,
): CompactionResult {
  const working: CompactableMessage[] = previousSummary
    ? [{ role: "system", content: previousSummary }, ...messages]
    : [...messages];
  const estimate = estimateTokens(working);
  const maxTokens = Math.max(RETRY_COMPACTION_FLOOR_TOKENS, Math.floor(estimate / 2));
  return compactSession(messages, { maxTokens, preserveRecent: 2, maxGroups: 20, previousSummary });
}

// ---------------------------------------------------------------------------
// The compaction decision, with the provider's own count as ground truth.
//
// Measured 2026-09-09 15:45-15:53 on the user's project: turns of 68-73k
// input tokens on a provider declared at 64k, and no "Session compacted"
// line — the estimate counted messages and the system prompt (chars/4) but
// not the ~30k chars of tool schemas, and under-read code-heavy content. The
// provider reports what it actually received; that number wins.
// ---------------------------------------------------------------------------

export interface CompactionDecision {
  /** max(estimate incl. tools, provider-observed input tokens). */
  readonly tokenEstimate: number;
  readonly trigger: boolean;
  /** Target for compactSession when triggered: window × target ratio minus the tool share, never under the floors. */
  readonly maxTokens: number;
  /** Tool schema tokens as a share of the window. */
  readonly toolShare: number;
  /** The schemas alone push the conversation to its floor: compaction cannot make room, the offer must shrink. */
  readonly toolShareExceeded: boolean;
}

export const COMPACTION_TARGET_FLOOR_TOKENS = 8_000;
/**
 * The conversation keeps at least this share of the window whatever the tool
 * schemas cost. Subtracting the schemas from the target alone (report
 * 2026-09-10 #33) compacted the conversation to make room for tools nobody
 * had chosen: 73k characters of schema on a 64k window left 14k tokens of
 * conversation. Past TOOL_SHARE_WARN_RATIO the floor holds and the caller is
 * told the offer is what has to shrink.
 */
export const COMPACTION_CONVERSATION_FLOOR_RATIO = 0.35;
export const TOOL_SHARE_WARN_RATIO = COMPACTION_TARGET_RATIO - COMPACTION_CONVERSATION_FLOOR_RATIO;

export function decideCompaction(input: {
  readonly estimatedTokens: number;
  readonly toolTokens?: number;
  readonly observedInputTokens?: number;
  readonly contextWindow: number;
}): CompactionDecision {
  const toolTokens = Math.max(0, input.toolTokens ?? 0);
  const observed = Math.max(0, input.observedInputTokens ?? 0);
  const tokenEstimate = Math.max(input.estimatedTokens + toolTokens, observed);
  const trigger = tokenEstimate > input.contextWindow * COMPACTION_TRIGGER_RATIO;
  const toolShare = input.contextWindow > 0 ? toolTokens / input.contextWindow : 0;
  const maxTokens = Math.max(
    COMPACTION_TARGET_FLOOR_TOKENS,
    Math.floor(input.contextWindow * COMPACTION_CONVERSATION_FLOOR_RATIO),
    Math.floor(input.contextWindow * COMPACTION_TARGET_RATIO) - toolTokens,
  );
  return { tokenEstimate, trigger, maxTokens, toolShare, toolShareExceeded: toolShare > TOOL_SHARE_WARN_RATIO };
}

/** ~4 chars per token, the same rule estimateTokens applies to Latin text. */
export function toolSchemaTokens(toolChars: number): number {
  return Math.ceil(Math.max(0, toolChars) / 4);
}
