/**
 * The daemon log's agent-loop calls, grouped into the sessions they belong to.
 *
 * Every "Provider call" line labelled "turn" carries its chat id and the
 * history's message count at the call. Every "Tool call" line follows the
 * call that asked for it. One chat id is not one session. A new session
 * restarts the count at one or two messages. Calls from another session can
 * also run under the same chat id, so a lone call with a small count can sit
 * between two calls of a long session. A count-reset split read that as a cut
 * to 15 messages, then a jump of 54, and turned the jump into one huge user
 * message.
 *
 * Several sessions can also run in lockstep under one chat id (1, 1, 1, 3, 3,
 * 3, ...). So the calls are assigned to tracks. A call fits an open track when
 * it extends that track's count by 0 to MAX_STEP messages and its history is
 * consistent with it: the same size when the count did not move, otherwise
 * not smaller. "History" here is the call's input minus its system prompt,
 * tool schemas and turn context. Among the tracks that fit, the one whose last system prompt
 * is closest in size wins: concurrent sessions run different prompts. A call
 * that fits none is classed as follows:
 * - a new session, when its count is at most two;
 * - otherwise a live cut (a compaction or a message-cap trim) of the open
 *   track whose count was at least as high, closest in prompt size. The
 *   exception is when that track resumes within the next LOOKAHEAD calls: a
 *   later call steps forward from the track's old count, and does so by a
 *   smaller step than it would from this call. Then this call came from
 *   another session and is set aside. A session pinned at its message cap
 *   (79, 77, 79, ...) does not count as resuming: its 79 after the cut is
 *   no forward step;
 * - otherwise a session whose start the log does not show. Its calls are
 *   counted and not replayed.
 * A "Tool call" line goes to the chat's most recent call that still has
 * unanswered tool calls. Under concurrency that is a guess. Calibration
 * (log-skeleton.ts) re-fits the total to the provider's count either way.
 */

/** One "Provider call" (label "turn") line with every count the replay needs. */
export interface TurnLine {
  readonly messages: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly promptChars: number;
  readonly toolChars: number;
  /**
   * The turn context the call sent after its history and never stored (src/agents/turn-context.ts);
   * 0 on lines written before it existed, when those sections sat inside the system prompt.
   */
  readonly turnContextChars: number;
  /** The "Tool call" lines logged after this call and before the chat's next one. */
  readonly tools: ToolLine[];
}

export interface ToolLine {
  readonly tool: string;
  readonly ok: boolean;
  readonly bytes?: number;
}

export interface LogSession {
  readonly id: string;
  readonly turns: readonly TurnLine[];
}

/** What the grouping read and set aside. */
export interface SessionStats {
  turnLines: number;
  turnsWithoutChat: number;
  turnsWithoutCounts: number;
  interleavedTurns: number;
  turnsWithUnknownStart: number;
  sessionsWithUnknownStart: number;
  toolLines: number;
  toolLinesUnused: number;
}

/** A session's count grows by two per call; more when calls left no line or the loop appended extra turns. */
const MAX_STEP = 12;
/** Calls looked ahead to tell a cut from a call of another session. */
const LOOKAHEAD = 4;
/**
 * How far a call's history may stray and still follow a track. A resent history is the same one,
 * up to how the head was subtracted (chars / 4 against the provider's tokenizer). A grown one may
 * look a little smaller when the system prompt changed a lot between the two calls.
 */
const RESEND_SLACK = { tokens: 100, ratio: 0.02 };
const GROWTH_SLACK = { tokens: 500, ratio: 0.05 };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  if (!line.includes('"Provider call"') && !line.includes('"Tool call"')) return null;
  try {
    const entry: unknown = JSON.parse(line);
    return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function turnLineOf(entry: Record<string, unknown>): TurnLine | null {
  const { messages, inputTokens, outputTokens, toolCalls, promptChars, toolChars } = entry;
  if (!isCount(messages) || !isCount(inputTokens) || !isCount(outputTokens)) return null;
  if (!isCount(toolCalls) || !isCount(promptChars) || !isCount(toolChars)) return null;
  const turnContextChars = isCount(entry.turnContextChars) ? entry.turnContextChars : 0;
  return { messages, inputTokens, outputTokens, toolCalls, promptChars, toolChars, turnContextChars, tools: [] };
}

/** What a call sent besides its history: the system prompt, the tool schemas and the turn context (chars / 4). */
export const overheadTokens = (t: TurnLine): number =>
  Math.ceil(t.promptChars / 4) + Math.ceil(t.toolChars / 4) + Math.ceil(t.turnContextChars / 4);

/** The history's share of a call: its input minus everything it sent besides the history. */
const historyTokens = (t: TurnLine): number => t.inputTokens - overheadTokens(t);

/** The most recent call that still has unanswered tool calls owns the next "Tool call" line. */
function ownerOf(calls: readonly (TurnLine | null)[]): TurnLine | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call && call.tools.length < call.toolCalls) return call;
  }
  return undefined;
}

/** Each chat's calls in log order; null marks a call whose counts are missing. */
function readChats(lines: Iterable<string>, accept: (entry: Record<string, unknown>) => boolean, stats: SessionStats): Map<string, (TurnLine | null)[]> {
  const chats = new Map<string, (TurnLine | null)[]>();
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry || !accept(entry)) continue;
    const chatId = typeof entry.chatId === "string" && entry.chatId.length > 0 ? entry.chatId : null;
    if (entry.message === "Provider call" && entry.label === "turn") {
      stats.turnLines++;
      if (!chatId) { stats.turnsWithoutChat++; continue; }
      const turn = turnLineOf(entry);
      if (!turn) stats.turnsWithoutCounts++;
      const calls = chats.get(chatId) ?? [];
      calls.push(turn);
      chats.set(chatId, calls);
    } else if (entry.message === "Tool call") {
      stats.toolLines++;
      const owner = chatId ? ownerOf(chats.get(chatId) ?? []) : undefined;
      if (owner) owner.tools.push({ tool: typeof entry.tool === "string" ? entry.tool : "tool", ok: entry.ok !== false, bytes: isCount(entry.bytes) ? entry.bytes : undefined });
      else stats.toolLinesUnused++;
    }
  }
  return chats;
}

interface Track {
  readonly turns: TurnLine[];
  /** Its start is not in the log: counted, never replayed. */
  readonly unknownStart: boolean;
  lastUsed: number;
}

/** Whether `next` can follow `last` in one session: a small step, and a history that did not shrink (or stayed put). */
export function canFollow(last: TurnLine, next: TurnLine): boolean {
  const step = next.messages - last.messages;
  if (step < 0 || step > MAX_STEP) return false;
  const before = historyTokens(last);
  const gap = historyTokens(next) - before;
  const { tokens, ratio } = step === 0 ? RESEND_SLACK : GROWTH_SLACK;
  const slack = Math.max(tokens, ratio * Math.max(0, before));
  return step === 0 ? Math.abs(gap) <= slack : gap >= -slack;
}

/** The open track `turn` follows, closest in system-prompt size; the most recently used on a tie. */
function bestFit(tracks: readonly Track[], turn: TurnLine): Track | undefined {
  let best: Track | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const track of tracks) {
    const last = track.turns.at(-1)!;
    if (!canFollow(last, turn)) continue;
    const distance = Math.abs(last.promptChars - turn.promptChars);
    if (distance < bestDistance || (distance === bestDistance && track.lastUsed > best!.lastUsed)) {
      best = track;
      bestDistance = distance;
    }
  }
  return best;
}

/** The open track `turn` would have cut: its count was at least as high; closest in prompt size, then most recent. */
function cutCandidate(tracks: readonly Track[], turn: TurnLine): Track | undefined {
  const distance = (t: Track) => Math.abs(t.turns.at(-1)!.promptChars - turn.promptChars);
  return tracks
    .filter((t) => !t.unknownStart && t.turns.at(-1)!.messages >= turn.messages)
    .sort((a, b) => distance(a) - distance(b) || b.lastUsed - a.lastUsed)[0];
}

/** The track steps forward from where it was within the next LOOKAHEAD calls: the call at `i` was not its cut. */
function resumes(track: Track, calls: readonly (TurnLine | null)[], i: number): boolean {
  const last = track.turns.at(-1)!;
  const turn = calls[i]!;
  for (let j = i + 1; j <= i + LOOKAHEAD && j < calls.length; j++) {
    const call = calls[j];
    if (call === null || call === undefined) return false;
    const fromTrack = call.messages - last.messages;
    const closerThanTurn = !canFollow(turn, call) || fromTrack < call.messages - turn.messages;
    if (fromTrack > 0 && canFollow(last, call) && closerThanTurn) return true;
  }
  return false;
}

function placeTurn(calls: readonly (TurnLine | null)[], i: number, tracks: Track[], stats: SessionStats): void {
  const turn = calls[i]!;
  const fit = bestFit(tracks, turn);
  if (fit) {
    fit.turns.push(turn);
    fit.lastUsed = i;
    return;
  }
  if (turn.messages <= 2) {
    tracks.push({ turns: [turn], unknownStart: false, lastUsed: i });
    return;
  }
  const cut = cutCandidate(tracks, turn);
  if (cut && resumes(cut, calls, i)) {
    stats.interleavedTurns++;
    stats.toolLinesUnused += turn.tools.length;
  } else if (cut) {
    cut.turns.push(turn);
    cut.lastUsed = i;
  } else {
    tracks.push({ turns: [turn], unknownStart: true, lastUsed: i });
  }
}

function segmentChat(calls: readonly (TurnLine | null)[], stats: SessionStats): TurnLine[][] {
  const done: Track[] = [];
  let tracks: Track[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i] === null) {
      // A call without its counts: nothing open can be followed past it.
      done.push(...tracks);
      tracks = [];
      continue;
    }
    placeTurn(calls, i, tracks, stats);
  }
  done.push(...tracks);
  const replayable: TurnLine[][] = [];
  for (const track of done.sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (!track.unknownStart) {
      replayable.push(track.turns);
      continue;
    }
    stats.sessionsWithUnknownStart++;
    stats.turnsWithUnknownStart += track.turns.length;
    stats.toolLinesUnused += track.turns.reduce((sum, t) => sum + t.tools.length, 0);
  }
  return replayable;
}

/** Reads daemon log lines, oldest first, into sessions; `accept` can drop entries (by time, say). */
export function readLogSessions(
  lines: Iterable<string>,
  accept: (entry: Record<string, unknown>) => boolean = () => true,
): { sessions: LogSession[]; stats: SessionStats } {
  const stats: SessionStats = {
    turnLines: 0, turnsWithoutChat: 0, turnsWithoutCounts: 0, interleavedTurns: 0,
    turnsWithUnknownStart: 0, sessionsWithUnknownStart: 0, toolLines: 0, toolLinesUnused: 0,
  };
  const sessions: LogSession[] = [];
  for (const [chatId, calls] of readChats(lines, accept, stats)) {
    segmentChat(calls, stats).forEach((turns, n) => sessions.push({ id: `${chatId}#${n + 1}`, turns }));
  }
  return { sessions, stats };
}
