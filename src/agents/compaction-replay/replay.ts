/**
 * Offline A/B of history compaction strategies over recorded sessions.
 *
 * Each arm replays every session call by call. Before each call it appends
 * what the loop appended, lets its strategy compact, and then accounts for the
 * request it would have sent:
 * - "append-only" never compacts. It is the reference, and it is how fidelity
 *   is checked against the logged input.
 * - "current" is the live pipeline, unchanged: decideCompaction and
 *   compactSession, called the way orchestrator.ts maybeCompactSession calls
 *   them, with the summary riding at the end of the system prompt.
 * - "cliff" is threshold-cliff.ts. The live window still rules: when the
 *   cliff leaves a request that the live decision would compact,
 *   compactSession runs as a backstop, and it is counted on its own.
 *
 * The cache is simulated by byte-prefix matching against the session's
 * previous request. The cached tokens of a call are the tokens of the longest
 * prefix it shares with that request. Two assumptions about the head (the
 * system prompt and tool schemas, which come before the history) bracket the
 * truth:
 * - "stable head": the head is byte-identical from call to call, so only the
 *   strategy breaks the prefix;
 * - "head as logged": a call whose prompt or tool-schema length differs from
 *   the previous call's misses entirely.
 * Not modelled: cache expiry, provider block granularity, cross-session hits,
 * output tokens (the same in every arm), the live message-cap trim, and how
 * often the model re-fetches what a stub replaced.
 */

import type { ConversationMessage } from "../providers/provider-core.interface.js";
import {
  COMPACTION_TRIGGER_RATIO,
  compactSession,
  decideCompaction,
  estimateTokens,
  toolSchemaTokens,
} from "../session-compaction.js";
import { estimateTextTokens } from "../../common/token-estimator.js";
import { planCliff, type CliffOptions } from "./threshold-cliff.js";
import type { ReplaySession, ReplayTurn } from "./transcript.js";

export type ArmSpec =
  | { readonly name: string; readonly kind: "append-only" | "current" }
  | { readonly name: string; readonly kind: "cliff"; readonly cliff: CliffOptions };

export interface ReplayOptions {
  /** The window decideCompaction plans against (the live default is DEFAULT_CONTEXT_WINDOW). */
  readonly contextWindow: number;
  /** Price of one uncached input token, in the unit the report names. */
  readonly priceUncached: number;
  /** Price of one cached input token, in the same unit. */
  readonly priceCached: number;
}

export interface ArmResult {
  readonly arm: string;
  readonly kind: ArmSpec["kind"];
  readonly sessions: number;
  readonly calls: number;
  /** History rewrites by the strategy: compactSession runs that compacted (current), cliff events (cliff). */
  readonly events: number;
  /** Cliff only: compactSession runs the live window forced after the cliff. */
  readonly backstops: number;
  /** Input tokens sent over all calls: the history re-sent each call, plus the head. */
  readonly inputTokens: number;
  readonly cachedStableHead: number;
  readonly cachedLoggedHead: number;
  readonly costStableHead: number;
  readonly costLoggedHead: number;
  readonly requestMedian: number;
  readonly requestP90: number;
  readonly requestMax: number;
}

/** How closely the append-only rebuild matches what the provider counted, before any live cut. */
export interface Fidelity {
  readonly calls: number;
  readonly medianAbsError: number | null;
  readonly p90AbsError: number | null;
}

// =============================================================================
// Request text: one piece per message, so the prefix match is cheap
// =============================================================================

interface Piece {
  readonly text: string;
  readonly tokens: number;
}

const pieces = new WeakMap<ConversationMessage, Piece>();

function messagePiece(m: ConversationMessage): Piece {
  let piece = pieces.get(m);
  if (!piece) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const calls = m.role === "assistant" ? JSON.stringify(m.tool_calls ?? []) : "";
    piece = { text: `${m.role}\u0000${content}\u0000${calls}`, tokens: estimateTokens([m]) };
    pieces.set(m, piece);
  }
  return piece;
}

/** What orchestrator.ts withCompactionSummary appends to the system prompt. */
const SUMMARY_HEADER = "\n\n## Prior conversation summary (compacted)\n";

const summaryPiece = (summary: string): Piece => ({
  text: `summary\u0000${summary}`,
  tokens: estimateTextTokens(SUMMARY_HEADER + summary),
});

const headTokens = (turn: ReplayTurn): number => estimateTokens([], turn.promptChars) + toolSchemaTokens(turn.toolChars);

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Tokens of the longest prefix `cur` shares with `prev`; a partly matching piece counts pro rata. */
export function sharedPrefixTokens(prev: readonly Piece[], cur: readonly Piece[]): number {
  let tokens = 0;
  for (let i = 0; i < cur.length && i < prev.length; i++) {
    const a = prev[i]!;
    const b = cur[i]!;
    if (a.text === b.text) {
      tokens += b.tokens;
      continue;
    }
    return tokens + Math.floor((b.tokens * commonPrefixLength(a.text, b.text)) / Math.max(1, b.text.length));
  }
  return tokens;
}

// =============================================================================
// Arms
// =============================================================================

interface ArmState {
  messages: ConversationMessage[];
  summary?: string;
  lastInputTokens?: number;
  /** Cliff only: where the last rewrite (event or backstop) left the conversation. */
  cliffAfterTokens?: number;
  events: number;
  backstops: number;
}

/** The live decision and call, as orchestrator.ts maybeCompactSession makes them. True when it compacted. */
function compactLikeLive(state: ArmState, turn: ReplayTurn, contextWindow: number): boolean {
  const decision = decideCompaction({
    estimatedTokens: estimateTokens(state.messages, turn.promptChars + (state.summary?.length ?? 0)),
    toolTokens: toolSchemaTokens(turn.toolChars),
    observedInputTokens: state.lastInputTokens,
    contextWindow,
  });
  if (!decision.trigger) return false;
  const result = compactSession(state.messages, {
    maxTokens: decision.maxTokens,
    preserveRecent: 4,
    maxGroups: 20,
    previousSummary: state.summary,
  });
  if (!result.compacted) return false;
  state.messages = result.messages;
  if (result.summary) state.summary = result.summary;
  state.lastInputTokens = undefined;
  return true;
}

/** Conversation tokens above which decideCompaction would trigger for this call (its estimate, inverted). */
function liveCeiling(state: ArmState, turn: ReplayTurn, contextWindow: number): number {
  const head = estimateTokens([], turn.promptChars + (state.summary?.length ?? 0)) + toolSchemaTokens(turn.toolChars);
  return Math.max(0, Math.floor(contextWindow * COMPACTION_TRIGGER_RATIO) - head);
}

function beforeCall(arm: ArmSpec, state: ArmState, turn: ReplayTurn, contextWindow: number): void {
  if (arm.kind === "current") {
    if (compactLikeLive(state, turn, contextWindow)) state.events++;
  } else if (arm.kind === "cliff") {
    const event = planCliff(state.messages, arm.cliff, {
      lastAfterTokens: state.cliffAfterTokens,
      ceilingTokens: liveCeiling(state, turn, contextWindow),
    });
    if (event) {
      state.messages = event.messages;
      state.lastInputTokens = undefined;
      state.cliffAfterTokens = event.afterTokens;
      state.events++;
    }
    if (compactLikeLive(state, turn, contextWindow)) {
      state.backstops++;
      state.cliffAfterTokens = estimateTokens(state.messages);
    }
  }
}

interface Totals {
  calls: number;
  inputTokens: number;
  cachedStableHead: number;
  cachedLoggedHead: number;
  requests: number[];
}

function replaySession(arm: ArmSpec, session: ReplaySession, contextWindow: number, totals: Totals): ArmState {
  const state: ArmState = { messages: [], events: 0, backstops: 0 };
  let prevPieces: Piece[] | null = null;
  let prevTurn: ReplayTurn | null = null;
  for (const turn of session.turns) {
    state.messages.push(...turn.append);
    beforeCall(arm, state, turn, contextWindow);
    const body = [...(state.summary ? [summaryPiece(state.summary)] : []), ...state.messages.map(messagePiece)];
    const head = headTokens(turn);
    const request = head + body.reduce((sum, p) => sum + p.tokens, 0);
    const stable = prevPieces ? head + sharedPrefixTokens(prevPieces, body) : 0;
    const headSame = prevTurn !== null && prevTurn.promptChars === turn.promptChars && prevTurn.toolChars === turn.toolChars;
    totals.calls++;
    totals.inputTokens += request;
    totals.cachedStableHead += stable;
    totals.cachedLoggedHead += headSame ? stable : 0;
    totals.requests.push(request);
    state.lastInputTokens = request;
    prevPieces = body;
    prevTurn = turn;
  }
  return state;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function replayArm(arm: ArmSpec, sessions: readonly ReplaySession[], options: ReplayOptions): ArmResult {
  const totals: Totals = { calls: 0, inputTokens: 0, cachedStableHead: 0, cachedLoggedHead: 0, requests: [] };
  let events = 0;
  let backstops = 0;
  for (const session of sessions) {
    const state = replaySession(arm, session, options.contextWindow, totals);
    events += state.events;
    backstops += state.backstops;
  }
  const cost = (cached: number) => (totals.inputTokens - cached) * options.priceUncached + cached * options.priceCached;
  const sorted = [...totals.requests].sort((a, b) => a - b);
  return {
    arm: arm.name,
    kind: arm.kind,
    sessions: sessions.length,
    calls: totals.calls,
    events,
    backstops,
    inputTokens: totals.inputTokens,
    cachedStableHead: totals.cachedStableHead,
    cachedLoggedHead: totals.cachedLoggedHead,
    costStableHead: cost(totals.cachedStableHead),
    costLoggedHead: cost(totals.cachedLoggedHead),
    requestMedian: percentile(sorted, 0.5),
    requestP90: percentile(sorted, 0.9),
    requestMax: sorted.at(-1) ?? 0,
  };
}

/**
 * The append-only rebuild against the provider's own count, on the calls made before the live
 * loop first cut a session's history (after that, the log describes a different history).
 */
export function replayFidelity(sessions: readonly ReplaySession[]): Fidelity {
  const errors: number[] = [];
  for (const session of sessions) {
    let history = 0;
    for (const turn of session.turns) {
      if (turn.liveCut) break;
      for (const m of turn.append) history += messagePiece(m).tokens;
      if (!turn.inputTokens) continue;
      errors.push(Math.abs(headTokens(turn) + history - turn.inputTokens) / turn.inputTokens);
    }
  }
  const sorted = errors.sort((a, b) => a - b);
  return {
    calls: sorted.length,
    medianAbsError: sorted.length > 0 ? percentile(sorted, 0.5) : null,
    p90AbsError: sorted.length > 0 ? percentile(sorted, 0.9) : null,
  };
}

/** How often the head changed between consecutive calls: each change breaks the prefix before the history. */
export interface HeadChurn {
  readonly transitions: number;
  readonly promptChanged: number;
  readonly toolsChanged: number;
}

export function headChurn(sessions: readonly ReplaySession[]): HeadChurn {
  let transitions = 0;
  let promptChanged = 0;
  let toolsChanged = 0;
  for (const { turns } of sessions) {
    for (let i = 1; i < turns.length; i++) {
      transitions++;
      if (turns[i]!.promptChars !== turns[i - 1]!.promptChars) promptChanged++;
      if (turns[i]!.toolChars !== turns[i - 1]!.toolChars) toolsChanged++;
    }
  }
  return { transitions, promptChanged, toolsChanged };
}
