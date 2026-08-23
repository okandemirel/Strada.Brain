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
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string | readonly ContentBlock[]; readonly is_error?: boolean };

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

function contentBlockIntoBuckets(block: ContentBlock, buckets: TokenBuckets): void {
  switch (block.type) {
    case "text": buckets.addText(block.text); return;
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
    return;
  }
  for (const block of msg.content) contentBlockIntoBuckets(block as ContentBlock, buckets);
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
    // Same-altitude cast as the content reads above: the runtime arrays carry
    // tool blocks that the nominal UserMessage/AssistantMessage content types
    // do not express.
    return { ...msg, content: blocks } as CompactableMessage;
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
  let sys: CompactableMessage[] = [];
  const rest: CompactableMessage[] = [];
  for (const msg of messages) { (msg.role === "system" ? sys : rest).push(msg); }

  let budget = maxTokens - estimateTokens(sys);
  if (budget <= 0) {
    // Defensive: the (capped) summary alone overruns the budget. NEVER return an
    // over-budget prompt — hard-truncate the summary TEXT itself to fit maxTokens.
    // maxTokens × 4 ≈ total char budget shared ACROSS all system messages (there
    // may be more than one: previous + freshly-appended summary). Drop the
    // conversation entirely; allocate the whole budget to the summaries head-first.
    // Reserve the "\n\n" join overhead that partitionSummary later adds between
    // summaries so the merged-and-measured result stays within maxTokens.
    const systemCount = sys.filter((m) => m.role === "system").length;
    const joinOverhead = systemCount > 1 ? (systemCount - 1) * 2 : 0;
    let remainingChars = Math.max(0, maxTokens * 4 - joinOverhead);
    sys = sys.map((m): CompactableMessage => {
      if (m.role !== "system" || typeof m.content !== "string") return m;
      const take = Math.min(m.content.length, remainingChars);
      remainingChars -= take;
      return { role: "system", content: m.content.slice(0, take) };
    });
    return sys;
  }

  const kept: CompactableMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens([rest[i]!]);
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
 * Splits a flat pipeline result into the system-free conversation and the
 * merged summary text extracted from system-role entries (front-positioned
 * by stages 2-4, so ordering is preserved by extraction).
 */
function partitionSummary(flat: readonly CompactableMessage[]): {
  messages: ConversationMessage[];
  summary: string | undefined;
} {
  // Drop any orphaned tool_use/tool_result references before partitioning so the
  // returned conversation can never trigger an Anthropic 400 (see dropOrphanToolMessages).
  const repaired = dropOrphanToolMessages(
    flat.filter((m): m is ConversationMessage => m.role !== "system"),
  );
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
