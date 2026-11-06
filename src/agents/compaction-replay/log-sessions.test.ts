/**
 * Grouping the daemon log's agent-loop calls into sessions. One chat id can
 * carry several sessions, in sequence or in lockstep, and calls of one session
 * can sit between another's. A grouping that misreads them invents cuts and
 * jumps the replay then compacts. The log lines here are invented.
 */
import { describe, expect, it } from "vitest";
import { readLogSessions } from "./log-sessions.js";

const PROMPT = 40_000;
const TOOLS = 8_000;
/** Tokens a call's system prompt and tool schemas account for at the defaults above. */
const HEAD = PROMPT / 4 + TOOLS / 4;

interface Call {
  chat?: string;
  m: number;
  /** History tokens: the call's input minus its head. */
  h: number;
  prompt?: number;
  toolCalls?: number;
  /** Turn context chars: sent after the history, never stored (src/agents/turn-context.ts). */
  ctx?: number;
}

const turn = ({ chat = "chat-a", m, h, prompt = PROMPT, toolCalls = 1, ctx }: Call): string =>
  JSON.stringify({
    timestamp: "2026-11-05 10:00:00",
    level: "info",
    message: "Provider call",
    label: "turn",
    chatId: chat,
    messages: m,
    inputTokens: h + prompt / 4 + TOOLS / 4 + (ctx ?? 0) / 4,
    outputTokens: 50,
    toolCalls,
    promptChars: prompt,
    toolChars: TOOLS,
    ...(ctx === undefined ? {} : { turnContextChars: ctx }),
  });

const tool = (bytes: number, chat = "chat-a"): string =>
  JSON.stringify({ timestamp: "2026-11-05 10:00:01", level: "info", message: "Tool call", chatId: chat, tool: "file_read", ok: true, bytes });

/** A session's calls: counts 1, 3, 5, ... and history growing by `grow` tokens a call. */
const run = (calls: number, opts: Partial<Call> & { from?: number; start?: number; grow?: number } = {}): Call[] =>
  Array.from({ length: calls }, (_, i) => ({ ...opts, m: (opts.from ?? 1) + 2 * i, h: (opts.start ?? 100) + i * (opts.grow ?? 1_000) }));

const counts = (sessions: { turns: readonly { messages: number }[] }[]) => sessions.map((s) => s.turns.map((t) => t.messages));

describe("readLogSessions", () => {
  it("follows a session whose turn context shrank, because the context is not history", () => {
    // The planning call's context (the planning prompt) is 32 000 chars, 8 000 tokens; the
    // executing calls' is 2 000. Counted as history, the drop would read as a cut.
    const calls = [{ m: 1, h: 400, ctx: 32_000 }, { m: 3, h: 900, ctx: 2_000 }, { m: 5, h: 1_400, ctx: 2_400 }];
    const { sessions, stats } = readLogSessions(calls.map(turn));
    expect(counts(sessions)).toEqual([[1, 3, 5]]);
    expect(sessions[0]!.turns.map((t) => t.turnContextChars)).toEqual([32_000, 2_000, 2_400]);
    expect(stats).toMatchObject({ interleavedTurns: 0, sessionsWithUnknownStart: 0 });
    // A line written before the field existed reads as no context.
    expect(readLogSessions([turn({ m: 1, h: 400 })]).sessions[0]!.turns[0]!.turnContextChars).toBe(0);
  });

  it("starts a new session where a chat's count restarts", () => {
    const { sessions } = readLogSessions([...run(3), ...run(2, { start: 300 })].map(turn));
    expect(counts(sessions)).toEqual([[1, 3, 5], [1, 3]]);
    expect(HEAD).toBe(12_000);
  });

  it("separates sessions that run in lockstep under one chat id by their system prompt size", () => {
    const a = run(4, { prompt: 40_000, start: 100, grow: 900 });
    const b = run(4, { prompt: 52_000, start: 600, grow: 1_100 });
    const interleaved = a.flatMap((call, i) => [call, b[i]!]);
    const { sessions, stats } = readLogSessions(interleaved.map(turn));
    expect(counts(sessions)).toEqual([[1, 3, 5, 7], [1, 3, 5, 7]]);
    expect(sessions.map((s) => s.turns.map((t) => t.promptChars)[0])).toEqual([40_000, 52_000]);
    expect(sessions.every((s) => s.turns.every((t) => t.promptChars === s.turns[0]!.promptChars))).toBe(true);
    expect(stats.interleavedTurns).toBe(0);
  });

  it("sets aside lone calls of another session instead of reading a cut and a jump", () => {
    const main = run(12, { start: 100, grow: 2_000 });
    const lone = [{ m: 5, h: 900, prompt: 60_000 }, { m: 7, h: 1_400, prompt: 60_000 }];
    const { sessions, stats } = readLogSessions([...main.slice(0, 8), ...lone, ...main.slice(8)].map(turn));
    expect(counts(sessions)).toEqual([main.map((c) => c.m)]);
    expect(stats.interleavedTurns).toBe(2);
  });

  it("reads a count that falls in the middle of a session as that session's cut, also at the message cap", () => {
    const grown = run(40, { start: 100, grow: 500 });
    const atCap = [{ m: 77, h: 19_000 }, { m: 79, h: 19_600 }, { m: 77, h: 19_200 }, { m: 79, h: 19_800 }];
    const { sessions, stats } = readLogSessions([...grown, ...atCap].map(turn));
    expect(counts(sessions)).toEqual([[...grown.map((c) => c.m), 77, 79, 77, 79]]);
    expect(stats.interleavedTurns).toBe(0);
  });

  it("does not replay a session whose first call already carries history the log never showed", () => {
    const { sessions, stats } = readLogSessions(run(3, { from: 41, start: 30_000 }).map(turn));
    expect(sessions).toEqual([]);
    expect(stats.sessionsWithUnknownStart).toBe(1);
    expect(stats.turnsWithUnknownStart).toBe(3);
  });

  it("gives a tool line to the most recent call that still has unanswered tool calls", () => {
    const lines = [
      turn({ m: 1, h: 100, prompt: 40_000, toolCalls: 1 }),
      turn({ m: 1, h: 700, prompt: 52_000, toolCalls: 2 }),
      tool(11),
      tool(22),
      tool(33),
      tool(44),
    ];
    const { sessions, stats } = readLogSessions(lines);
    expect(sessions.map((s) => s.turns[0]!.tools.map((t) => t.bytes))).toEqual([[33], [11, 22]]);
    expect(stats.toolLinesUnused).toBe(1);
  });

  it("ends what can be followed at a call whose counts are missing, and skips a call with no chat id", () => {
    const broken = JSON.stringify({ message: "Provider call", label: "turn", chatId: "chat-a", inputTokens: 13_000 });
    const anonymous = JSON.stringify({ message: "Provider call", label: "turn", messages: 3, inputTokens: 13_000 });
    const { sessions, stats } = readLogSessions([turn({ m: 1, h: 100 }), turn({ m: 3, h: 900 }), broken, anonymous, turn({ m: 5, h: 1_800 })]);
    expect(counts(sessions)).toEqual([[1, 3]]);
    expect(stats).toMatchObject({ turnLines: 5, turnsWithoutCounts: 1, turnsWithoutChat: 1, sessionsWithUnknownStart: 1 });
  });

  it("reads only what the filter accepts", () => {
    const lines = [...run(2).map(turn), ...run(2, { chat: "chat-b" }).map(turn)];
    const { sessions } = readLogSessions(lines, (entry) => entry.chatId === "chat-b");
    expect(sessions.map((s) => s.id)).toEqual(["chat-b#1"]);
  });
});
