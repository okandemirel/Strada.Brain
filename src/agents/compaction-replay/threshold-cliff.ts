/**
 * The threshold-cliff compaction design, for the offline A/B only. Nothing in
 * the live loop calls it.
 *
 * Every rewrite of the history breaks the provider's prefix cache from the
 * first changed byte on, and a cached token costs about a fiftieth of an
 * uncached one (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md).
 * So the cliff is built to rewrite rarely and in a stable way:
 * - Between events the history is append-only. Nothing is touched below the
 *   trigger.
 * - An event happens only above a high trigger. It masks oldest-first down to
 *   a floor, and is not made at all when it would reclaim less than a minimum.
 * - After an event, the next one waits until the conversation has grown by
 *   (trigger - floor) past where the last event left it. In a long session
 *   the part that is never masked can outgrow the trigger. Without this wait
 *   the cliff would then fire every few turns, as the rolling mask did.
 * - The window still rules. The trigger in force never rises above the
 *   conversation size at which the live decision would compact, so the cliff
 *   fires first. When it cannot reclaim its minimum there, the live
 *   pipeline's compaction is the backstop (replay.ts counts it).
 * - A masked block becomes a stub that is a pure function of the block and
 *   its call. The same input always gives the same bytes. A stub is never
 *   rewritten, so the prefix up to the oldest newly masked block stays cached.
 * - The stub carries the call that fetches the content again and every
 *   failure line of what it replaced.
 * - Never masked: results of at most 500 characters, the newest ~10 tool
 *   results, the original task, user turns, and the assistant's reasoning
 *   text (the latest included).
 *
 * Masking is two tiers, both oldest-first. Tier 1 is observations: tool
 * results, and long notes the loop appended after them. Tier 2 is long string
 * fields in older tool-call inputs. Tier 2 runs only when tier 1 cannot reach
 * the floor.
 */

import type { ConversationMessage, MessageContent, ToolCall } from "../providers/provider-core.interface.js";
import type { JsonObject } from "../../types/index.js";
import { estimateTokens } from "../session-compaction.js";

export interface CliffOptions {
  /** Conversation tokens (messages only) above which an event is considered. */
  readonly triggerTokens: number;
  /** An event masks oldest-first until the conversation is at or under this. */
  readonly floorTokens: number;
  /** An event that would reclaim less than this is not made: the history stays append-only. */
  readonly minReclaimTokens: number;
  /** The newest tool results kept verbatim whatever their size. */
  readonly keepRecentResults?: number;
  /** A result, note or input field of at most this many characters is never masked. */
  readonly verbatimMaxChars?: number;
}

export interface CliffEvent {
  readonly messages: ConversationMessage[];
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** Blocks and input fields this event masked. */
  readonly masked: number;
}

export const DEFAULT_KEEP_RECENT_RESULTS = 10;
export const DEFAULT_VERBATIM_MAX_CHARS = 500;
/** Every stub starts with this; a block that does is never masked again. */
export const STUB_PREFIX = "[elided ";

/** A line that names a failure. It is copied into the stub of the block it came from. */
const FAILURE_LINE = /\b(?:error|errors|failed|failure|fails|exception|fatal|refused|denied|panic|traceback)\b|\[STRADA/i;
const FAILURE_LINE_MAX_CHARS = 300;
const REFETCH_INPUT_MAX_CHARS = 300;
const ABRIDGED_VALUE_CHARS = 80;

const isStub = (text: string): boolean => text.startsWith(STUB_PREFIX);

/** Every distinct failure line of `text`, each cut to a bounded width; the first line when an error result names none. */
export function failureLines(text: string, isError: boolean): string[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const matched = [...new Set(lines.filter((l) => FAILURE_LINE.test(l)))];
  const kept = matched.length > 0 ? matched : isError && lines[0] ? [lines[0]] : [];
  return kept.map((l) => (l.length > FAILURE_LINE_MAX_CHARS ? `${l.slice(0, FAILURE_LINE_MAX_CHARS)}…` : l));
}

/** The call as JSON; long string values are replaced by their length when the whole would be too long. */
function refetchInput(input: unknown): string {
  const exact = JSON.stringify(input ?? {});
  if (exact.length <= REFETCH_INPUT_MAX_CHARS) return exact;
  const abridged = JSON.stringify(input ?? {}, (_key, value: unknown) =>
    typeof value === "string" && value.length > ABRIDGED_VALUE_CHARS ? `<${value.length} chars>` : value,
  );
  return `${abridged.slice(0, REFETCH_INPUT_MAX_CHARS)}${abridged.length > REFETCH_INPUT_MAX_CHARS ? "…" : ""} (input abridged)`;
}

export function resultStub(call: Pick<ToolCall, "name" | "input"> | undefined, content: string, isError: boolean): string {
  const refetch = call ? `${call.name} ${refetchInput(call.input)}` : "(its call is no longer in the history)";
  const head = `${STUB_PREFIX}tool result: ${content.length} chars${isError ? ", failed" : ""}. Re-fetch with: ${refetch}]`;
  return [head, ...failureLines(content, isError)].join("\n");
}

export function noteStub(text: string): string {
  return [`${STUB_PREFIX}note: ${text.length} chars]`, ...failureLines(text, false)].join("\n");
}

const fieldStub = (chars: number): string => `${STUB_PREFIX}input field: ${chars} chars]`;

/** The input with every long field stubbed, or null when no field is long. */
function stubbedInput(input: JsonObject, verbatimMax: number): JsonObject | null {
  let changed = false;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    if (text.length > verbatimMax && !(typeof value === "string" && isStub(value))) {
      out[key] = fieldStub(text.length);
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : null;
}

// =============================================================================
// Choosing and applying the masks
// =============================================================================

type Edit =
  | { readonly kind: "result" | "note"; readonly msg: number; readonly block: number }
  | { readonly kind: "input"; readonly msg: number; readonly call: number };

const blocksOf = (m: ConversationMessage): readonly MessageContent[] | null =>
  m.role === "user" && typeof m.content !== "string" ? m.content : null;

const isLong = (text: string, verbatimMax: number): boolean => text.length > verbatimMax && !isStub(text);

function callIndex(messages: readonly ConversationMessage[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.set(c.id, c);
  }
  return calls;
}

/** The newest `keep` tool results, by position: they are never masked, nor are notes beside or after them. */
function protectedResults(messages: readonly ConversationMessage[], keep: number): { keys: Set<string>; ids: Set<string>; fromMsg: number } {
  const all: { msg: number; block: number; id: string }[] = [];
  messages.forEach((m, msg) => blocksOf(m)?.forEach((b, block) => {
    if (b.type === "tool_result") all.push({ msg, block, id: b.tool_use_id });
  }));
  const kept = keep > 0 ? all.slice(-keep) : [];
  return {
    keys: new Set(kept.map((r) => `${r.msg}:${r.block}`)),
    ids: new Set(kept.map((r) => r.id)),
    fromMsg: kept[0]?.msg ?? Number.POSITIVE_INFINITY,
  };
}

/** Tier 1 (observations) then tier 2 (older call inputs), each oldest-first. */
function candidates(messages: readonly ConversationMessage[], keep: number, verbatimMax: number): Edit[] {
  const guard = protectedResults(messages, keep);
  const tier1: Edit[] = [];
  messages.forEach((m, msg) => {
    const blocks = blocksOf(m);
    // Only a turn that answers tool calls holds observations; a turn someone wrote is never masked.
    if (!blocks?.some((b) => b.type === "tool_result")) return;
    blocks.forEach((b, block) => {
      if (b.type === "tool_result" && !guard.keys.has(`${msg}:${block}`) && isLong(b.content, verbatimMax)) {
        tier1.push({ kind: "result", msg, block });
      } else if (b.type === "text" && msg < guard.fromMsg && isLong(b.text, verbatimMax)) {
        tier1.push({ kind: "note", msg, block });
      }
    });
  });
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === "assistant") lastAssistant = i; });
  const tier2: Edit[] = [];
  messages.forEach((m, msg) => {
    if (m.role !== "assistant" || msg === lastAssistant) return;
    (m.tool_calls ?? []).forEach((c, call) => {
      if (!guard.ids.has(c.id) && stubbedInput(c.input, verbatimMax)) tier2.push({ kind: "input", msg, call });
    });
  });
  return [...tier1, ...tier2];
}

/** The message with one edit applied; the input message is not changed. */
function applied(m: ConversationMessage, edit: Edit, calls: ReadonlyMap<string, ToolCall>, verbatimMax: number): ConversationMessage {
  if (edit.kind === "input") {
    if (m.role !== "assistant" || !m.tool_calls) return m;
    const toolCalls = [...m.tool_calls];
    const call = toolCalls[edit.call]!;
    toolCalls[edit.call] = { ...call, input: stubbedInput(call.input, verbatimMax) ?? call.input };
    return { ...m, tool_calls: toolCalls };
  }
  const blocks = blocksOf(m);
  if (!blocks) return m;
  const next = [...blocks];
  const b = next[edit.block]!;
  if (b.type === "tool_result") next[edit.block] = { ...b, content: resultStub(calls.get(b.tool_use_id), b.content, b.is_error === true) };
  else if (b.type === "text") next[edit.block] = { ...b, text: noteStub(b.text) };
  return { role: "user", content: next };
}

/** Where the session stands: what the last rewrite left, and the size at which the live window compacts. */
export interface CliffBounds {
  /** Conversation tokens the session's last event (or backstop) left. */
  readonly lastAfterTokens?: number;
  /** Conversation tokens above which the live decision would compact this call. */
  readonly ceilingTokens?: number;
}

/**
 * The trigger in force: the configured one, raised to the last event's result plus (trigger - floor),
 * and capped at the live ceiling.
 */
export function effectiveTrigger(opts: CliffOptions, bounds: CliffBounds = {}): number {
  const { lastAfterTokens, ceilingTokens } = bounds;
  const waited = lastAfterTokens === undefined
    ? opts.triggerTokens
    : Math.max(opts.triggerTokens, lastAfterTokens + (opts.triggerTokens - opts.floorTokens));
  return ceilingTokens === undefined ? waited : Math.min(waited, ceilingTokens);
}

/**
 * The cliff's event for this history, or null when it makes none: the conversation is at or under
 * the trigger in force, or masking would reclaim less than the minimum. Pure and deterministic.
 */
export function planCliff(messages: readonly ConversationMessage[], opts: CliffOptions, bounds: CliffBounds = {}): CliffEvent | null {
  const beforeTokens = estimateTokens(messages);
  if (beforeTokens <= effectiveTrigger(opts, bounds)) return null;
  const verbatimMax = opts.verbatimMaxChars ?? DEFAULT_VERBATIM_MAX_CHARS;
  const keep = opts.keepRecentResults ?? DEFAULT_KEEP_RECENT_RESULTS;
  const calls = callIndex(messages);
  const out = [...messages];
  let tokens = beforeTokens;
  let masked = 0;
  for (const edit of candidates(messages, keep, verbatimMax)) {
    if (tokens <= opts.floorTokens) break;
    const old = out[edit.msg]!;
    const next = applied(old, edit, calls, verbatimMax);
    const saved = estimateTokens([old]) - estimateTokens([next]);
    // A stub that keeps many failure lines can outweigh what it replaces: leave that block alone.
    if (saved <= 0) continue;
    out[edit.msg] = next;
    tokens -= saved;
    masked++;
  }
  const afterTokens = estimateTokens(out);
  if (beforeTokens - afterTokens < opts.minReclaimTokens) return null;
  return { messages: out, beforeTokens, afterTokens, masked };
}

