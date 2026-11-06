/**
 * Shape replay: sessions rebuilt from the daemon log's "Provider call" (label
 * "turn") and "Tool call" lines, grouped into sessions by log-sessions.ts.
 *
 * No store keeps message content, on purpose: the log must not become a
 * transcript. What the log does keep is enough to rebuild each session's
 * SHAPE. Per call it has the history's message count, the provider's input
 * and output tokens, the number of tool calls, and the system prompt and tool
 * schema sizes. Per tool call it has the tool, whether it failed, and the
 * result's size. The rebuilt messages are those sizes filled with
 * deterministic placeholder text. Event counts, re-sent tokens and cost depend
 * on sizes, so they replay faithfully. The rules that read content (failure
 * lines, re-fetch calls) are exercised on invented content only, and the
 * report says so.
 *
 * Calibration. Between two calls of a session whose message count grew, the
 * provider's input grew by exactly what was appended, plus any change in the
 * system prompt, tool schemas and turn context. That difference sizes what the log does not
 * record: results of tool calls that left no "Tool call" line, and any text
 * the loop appended after them. A transition where the count fell (the live
 * loop cut its history) cannot be calibrated: logged sizes are used, and a
 * result without one gets the session's median.
 */

import type { ConversationMessage, MessageContent, ToolCall } from "../providers/provider-core.interface.js";
import type { JsonObject } from "../../types/index.js";
import { overheadTokens, readLogSessions, type SessionStats, type ToolLine, type TurnLine } from "./log-sessions.js";
import type { ReplaySession, ReplayTurn } from "./transcript.js";

/** The shared estimator's rate for Latin text; placeholder content is ASCII. */
const CHARS_PER_TOKEN = 4;
/** Assistant text kept beside tool calls; the rest of the output is the calls' input. */
const ASSISTANT_TEXT_CHARS = 400;
/** Smallest message or result the rebuild writes, so no turn is empty. */
const MIN_CHARS = 40;
/** A session's result size when it logged none at all. */
const DEFAULT_RESULT_CHARS = 1_000;

/** How each message was sized; the report prints it beside the grouping's counts. */
export interface SizingStats {
  resultsLogged: number;
  resultsInferred: number;
  resultsDefaulted: number;
  calibratedTransitions: number;
  uncalibratedTransitions: number;
  liveHistoryDrops: number;
  retriedTurns: number;
}

/** What the rebuild read, used, guessed and dropped: the report prints all of it. */
export type SkeletonStats = SessionStats & SizingStats;

export interface Skeleton {
  readonly sessions: ReplaySession[];
  readonly stats: SkeletonStats;
}

/** Reads daemon log lines, oldest first, into replayable sessions; `accept` can drop entries (by time, say). */
export function buildSkeleton(lines: Iterable<string>, accept?: (entry: Record<string, unknown>) => boolean): Skeleton {
  const grouped = readLogSessions(lines, accept);
  const stats: SkeletonStats = {
    ...grouped.stats,
    resultsLogged: 0, resultsInferred: 0, resultsDefaulted: 0, calibratedTransitions: 0,
    uncalibratedTransitions: 0, liveHistoryDrops: 0, retriedTurns: 0,
  };
  return { sessions: grouped.sessions.map((s) => buildSession(s.id, s.turns, stats)), stats };
}

// =============================================================================
// Placeholder content
// =============================================================================

/**
 * Deterministic ASCII text of exactly `chars` characters, in lines, distinct per seed. It holds no
 * word a failure-line pattern reads; failure lines are written on purpose (failureLine).
 */
export function filler(seed: string, chars: number): string {
  if (chars <= 0) return "";
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const line = `${seed}:${i} lorem ipsum dolor sit amet consectetur adipiscing\n`;
    parts.push(line);
    length += line.length;
  }
  return parts.join("").slice(0, chars);
}

function failureLine(tool: string): string {
  return `Error: ${tool} failed (placeholder failure line)\n`;
}

function resultText(seed: string, tool: string, chars: number, ok: boolean): string {
  if (ok) return filler(seed, chars);
  const head = failureLine(tool);
  return head + filler(seed, Math.max(0, chars - head.length));
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function buildSession(id: string, raw: readonly TurnLine[], stats: SkeletonStats): ReplaySession {
  const logged = raw.flatMap((t) => t.tools.map((x) => x.bytes)).filter((b): b is number => b !== undefined);
  const fallbackResult = median(logged) ?? DEFAULT_RESULT_CHARS;
  const turns: ReplayTurn[] = raw.map((cur, i) => {
    const append = i === 0
      ? [taskMessage(id, cur)]
      : transition(`${id}/t${i}`, raw[i - 1]!, cur, fallbackResult, stats);
    const liveCut = i > 0 && cur.messages < raw[i - 1]!.messages;
    if (liveCut) stats.liveHistoryDrops++;
    return {
      promptChars: cur.promptChars,
      toolChars: cur.toolChars,
      ...(cur.turnContextChars > 0 ? { turnContextChars: cur.turnContextChars } : {}),
      inputTokens: cur.inputTokens,
      ...(liveCut ? { liveCut } : {}),
      append,
    };
  });
  // The last response was never re-sent: nothing appends it, and its tool lines go unused.
  stats.toolLinesUnused += raw.at(-1)?.tools.length ?? 0;
  return { id, turns };
}

/** The opening user turn: everything the first call carried beyond the system prompt, tools and turn context. */
function taskMessage(id: string, first: TurnLine): ConversationMessage {
  const chars = Math.max(MIN_CHARS, (first.inputTokens - overheadTokens(first)) * CHARS_PER_TOKEN);
  return { role: "user", content: filler(`${id}/task`, chars) };
}

interface Sizing {
  readonly assistantChars: number;
  /** One size per tool call, in call order. */
  readonly resultChars: number[];
  readonly noteChars: number;
}

/** The messages that turn `prev`'s response and results into history before `cur` was sent. */
function transition(seed: string, prev: TurnLine, cur: TurnLine, fallbackResult: number, stats: SkeletonStats): ConversationMessage[] {
  const added = cur.messages - prev.messages;
  if (added === 0) {
    // Sent again over the same history: the previous response was not kept.
    stats.retriedTurns++;
    stats.toolLinesUnused += prev.tools.length;
    return [];
  }
  const tools = prev.tools.slice(0, prev.toolCalls);
  stats.toolLinesUnused += prev.tools.length - tools.length;
  const growth = (cur.inputTokens - prev.inputTokens) - (overheadTokens(cur) - overheadTokens(prev));
  const sizing = added > 0 && growth >= 0
    ? calibrated(prev, tools, growth * CHARS_PER_TOKEN, stats)
    : uncalibrated(prev, tools, fallbackResult, stats);
  return messagesFor(seed, prev, tools, sizing, added);
}

function calibrated(prev: TurnLine, tools: readonly ToolLine[], appendedChars: number, stats: SkeletonStats): Sizing {
  stats.calibratedTransitions++;
  const loggedChars = tools.reduce((sum, t) => sum + (t.bytes ?? 0), 0);
  const assistantChars = Math.min(prev.outputTokens * CHARS_PER_TOKEN, Math.max(0, appendedChars - loggedChars));
  let leftover = Math.max(0, appendedChars - assistantChars - loggedChars);
  const unlogged = prev.toolCalls - tools.filter((t) => t.bytes !== undefined).length;
  const share = unlogged > 0 ? Math.max(MIN_CHARS, Math.floor(leftover / unlogged)) : 0;
  if (unlogged > 0) leftover = 0;
  stats.resultsLogged += prev.toolCalls - unlogged;
  stats.resultsInferred += unlogged;
  const resultChars = Array.from({ length: prev.toolCalls }, (_, j) => tools[j]?.bytes ?? share);
  return { assistantChars, resultChars, noteChars: leftover >= MIN_CHARS ? leftover : 0 };
}

function uncalibrated(prev: TurnLine, tools: readonly ToolLine[], fallbackResult: number, stats: SkeletonStats): Sizing {
  stats.uncalibratedTransitions++;
  const resultChars = Array.from({ length: prev.toolCalls }, (_, j) => tools[j]?.bytes ?? fallbackResult);
  const unlogged = resultChars.filter((_, j) => tools[j]?.bytes === undefined).length;
  stats.resultsLogged += prev.toolCalls - unlogged;
  stats.resultsDefaulted += unlogged;
  return { assistantChars: prev.outputTokens * CHARS_PER_TOKEN, resultChars, noteChars: 0 };
}

function messagesFor(seed: string, prev: TurnLine, tools: readonly ToolLine[], s: Sizing, added: number): ConversationMessage[] {
  if (prev.toolCalls === 0) {
    const assistant: ConversationMessage = { role: "assistant", content: filler(`${seed}/a`, Math.max(MIN_CHARS, s.assistantChars)) };
    if (added === 1) return [assistant];
    return [assistant, { role: "user", content: filler(`${seed}/u`, Math.max(MIN_CHARS, s.noteChars)) }];
  }
  const textChars = Math.min(s.assistantChars, ASSISTANT_TEXT_CHARS);
  const inputChars = Math.floor((s.assistantChars - textChars) / prev.toolCalls);
  const calls: ToolCall[] = s.resultChars.map((_, j) => {
    const ref = `${seed}/c${j}`;
    const input: JsonObject = { ref };
    if (inputChars > ref.length + 20) input.body = filler(ref, inputChars - ref.length - 20);
    return { id: ref, name: tools[j]?.tool ?? "unlogged_tool", input };
  });
  const blocks: MessageContent[] = calls.map((call, j) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: resultText(`${call.id}/r`, call.name, Math.max(MIN_CHARS, s.resultChars[j]!), tools[j]?.ok !== false),
    is_error: tools[j]?.ok === false,
  }));
  if (s.noteChars > 0) blocks.push({ type: "text", text: filler(`${seed}/n`, s.noteChars) });
  return [
    { role: "assistant", content: filler(`${seed}/a`, textChars), tool_calls: calls },
    { role: "user", content: blocks },
  ];
}
