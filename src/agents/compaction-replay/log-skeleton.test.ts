/**
 * The shape replay's rebuild: real sizes from the log, placeholder content,
 * and the provider's own count used to size what the log did not record. The
 * log lines here are invented.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage, MessageContent } from "../providers/provider-core.interface.js";
import { estimateTokens } from "../session-compaction.js";
import { buildSkeleton, filler } from "./log-skeleton.js";
import { failureLines } from "./threshold-cliff.js";

const PROMPT = 40_000;
const TOOLS = 8_000;
const HEAD = PROMPT / 4 + TOOLS / 4;

const turn = (m: number, history: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    timestamp: "2026-11-05 10:00:00",
    level: "info",
    message: "Provider call",
    label: "turn",
    chatId: "chat-a",
    messages: m,
    inputTokens: HEAD + history,
    outputTokens: 100,
    toolCalls: 1,
    promptChars: PROMPT,
    toolChars: TOOLS,
    ...extra,
  });

const tool = (bytes: number, ok = true): string =>
  JSON.stringify({ level: "info", message: "Tool call", chatId: "chat-a", tool: "file_read", ok, bytes });

const resultBlocks = (m: ConversationMessage | undefined): Extract<MessageContent, { type: "tool_result" }>[] =>
  m && m.role === "user" && typeof m.content !== "string"
    ? m.content.filter((b): b is Extract<MessageContent, { type: "tool_result" }> => b.type === "tool_result")
    : [];

describe("buildSkeleton", () => {
  it("opens with the task, sized as the first call's input less its system prompt and tool schemas", () => {
    const { sessions } = buildSkeleton([turn(1, 500)]);
    expect(sessions).toHaveLength(1);
    const [task] = sessions[0]!.turns[0]!.append;
    expect(task).toMatchObject({ role: "user" });
    expect(String(task!.content)).toHaveLength(2_000);
    expect(sessions[0]!.turns[0]).toMatchObject({ promptChars: PROMPT, toolChars: TOOLS, inputTokens: HEAD + 500 });
  });

  it("sizes a result the log did not record from the input's growth, so the rebuild matches the provider's count", () => {
    // 100 output tokens + a logged 4 000-char result (1 000 tokens) + an unlogged one: 3 000 tokens left over.
    const lines = [turn(1, 500, { toolCalls: 2 }), tool(4_000), turn(3, 500 + 100 + 1_000 + 3_000)];
    const { sessions, stats } = buildSkeleton(lines);
    const [assistant, results] = sessions[0]!.turns[1]!.append;
    expect(assistant).toMatchObject({ role: "assistant" });
    expect(assistant!.role === "assistant" ? assistant!.tool_calls?.map((c) => c.name) : []).toEqual(["file_read", "unlogged_tool"]);
    expect(resultBlocks(results).map((b) => b.content.length)).toEqual([4_000, 12_000]);
    expect(stats).toMatchObject({ resultsLogged: 1, resultsInferred: 1, calibratedTransitions: 1 });
    // Within 1%: the calls' names and ids are counted by the estimator and not budgeted by the sizing.
    const history = sessions[0]!.turns.flatMap((t) => t.append);
    expect(Math.abs(estimateTokens(history) - 4_600)).toBeLessThanOrEqual(46);
  });

  it("keeps text the loop appended after the results as a note, and writes a failed result with its failure line", () => {
    const lines = [turn(1, 500), tool(400, false), turn(3, 500 + 100 + 100 + 2_000)];
    const { sessions } = buildSkeleton(lines);
    const results = sessions[0]!.turns[1]!.append[1]!;
    const [block] = resultBlocks(results);
    expect(block!.is_error).toBe(true);
    expect(failureLines(block!.content, true)).toEqual(["Error: file_read failed (placeholder failure line)"]);
    const blocks = results.role === "user" && typeof results.content !== "string" ? results.content : [];
    expect(blocks.at(-1)).toMatchObject({ type: "text" });
    expect(blocks.at(-1)!.type === "text" ? blocks.at(-1)!.text.length : 0).toBe(8_000);
  });

  it("appends nothing for a call that resent the same history", () => {
    const { sessions, stats } = buildSkeleton([turn(1, 500), tool(400), turn(1, 500), turn(3, 1_000)]);
    expect(sessions[0]!.turns.map((t) => t.append.length)).toEqual([1, 0, 2]);
    expect(stats.retriedTurns).toBe(1);
  });

  it("marks the call after a live cut and sizes across it from the log alone", () => {
    const grown = [1, 3, 5, 7].flatMap((m, i) => [turn(m, 500 + i * 3_000), tool(8_000)]);
    const beforeCut = [turn(9, 12_500, { toolCalls: 2 }), tool(5_000)];
    const { sessions, stats } = buildSkeleton([...grown, ...beforeCut, turn(7, 9_000), tool(2_000), turn(9, 12_000)]);
    const turns = sessions[0]!.turns;
    expect(turns.map((t) => t.liveCut === true)).toEqual([false, false, false, false, false, true, false]);
    expect(stats).toMatchObject({ liveHistoryDrops: 1, uncalibratedTransitions: 1, resultsDefaulted: 1 });
    // Across the cut: the logged size, and the session's median (8 000) for the result with no line.
    expect(resultBlocks(turns[5]!.append[1]).map((b) => b.content.length)).toEqual([5_000, 8_000]);
  });

  it("writes deterministic placeholder text of the exact size that names no failure", () => {
    expect(filler("seed", 1_234)).toHaveLength(1_234);
    expect(filler("seed", 1_234)).toBe(filler("seed", 1_234));
    expect(filler("seed", 500)).not.toBe(filler("other", 500));
    expect(failureLines(filler("seed", 5_000), false)).toEqual([]);
    expect(filler("seed", 0)).toBe("");
  });
});
