/**
 * Stage 4 keeps the pinned turns within the budget whatever their blocks are (board #76).
 *
 * Measured in #63 by calling compactSession directly: an image counts a fixed 1600 tokens and
 * stage 4's shrinkGroup could not cut it, so a pinned task with more image than budget came back
 * over maxTokens. The same held for every block shrinkGroup did not touch while the estimator
 * counted it:
 *
 *   block                                     | counted as                 | shrinkGroup before #76
 *   image in a turn's content                 | 1600 tokens each           | untouched
 *   tool_result with array content: text     | its text                   | untouched
 *   tool_result with array content: image    | 1600 tokens each           | untouched
 *   tool_use content block                    | name + JSON of its input   | untouched
 *   tool_calls input of many small keys       | name + JSON of its input   | compacted, every key kept
 *
 * The live target is at least COMPACTION_TARGET_FLOOR_TOKENS (8000), so each case is run there.
 */

import { describe, it, expect } from "vitest";
import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { COMPACTION_TARGET_FLOOR_TOKENS, compactSession, imageNote } from "./session-compaction.js";
import { taskTurn, isTaskTurn } from "./orchestrator-session-manager-task-turn.js";

const TASK = "Match the reading-room floor plan to these sketches and list every shelf that moved.";
const BUDGET = COMPACTION_TARGET_FLOOR_TOKENS;

type Block = { type: string; text?: string; content?: unknown };

function image(tag: string) {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: `iVBORw0KGgo${tag}` } };
}

function toolPairs(prefix: string, count: number): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    out.push({ role: "assistant", content: "", tool_calls: [{ id, name: "file_read", input: { path: `src/${id}.ts` } }] } as ConversationMessage);
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${id}: `.padEnd(400, "r") }] } as ConversationMessage);
  }
  return out;
}

/** The task, some work, then the newest group: the two turns stage 4 pins. */
function history(task: ConversationMessage, newest: ConversationMessage[] = toolPairs("z", 1)): ConversationMessage[] {
  return [task, ...toolPairs("a", 6), { role: "assistant", content: "Read the plan; comparing next." }, ...newest];
}

function blocksOf(message: ConversationMessage): Block[] {
  return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** A newest tool call whose result is the given array content. */
function arrayResultTurn(content: unknown[]): ConversationMessage[] {
  return [
    { role: "assistant", content: "", tool_calls: [{ id: "shot", name: "unity_screenshot", input: {} }] } as ConversationMessage,
    { role: "user", content: [{ type: "tool_result", tool_use_id: "shot", content }] } as ConversationMessage,
  ];
}

describe("stage 4 keeps pinned turns within the budget, whatever their blocks (board #76)", () => {
  it("a task with five images fits 8000 tokens: the task's text stays verbatim, the oldest images become notes in place", () => {
    const task = taskTurn([{ type: "text", text: TASK }, image("1"), image("2"), image("3"), image("4"), image("5")]);
    const result = compactSession(history(task), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.stageApplied).toBe("hard_truncation");
    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);

    const kept = result.messages.find((m) => isTaskTurn(m));
    expect(kept, "the task turn is in the history").toBeDefined();
    const blocks = blocksOf(kept!);
    expect(blocks[0]).toEqual({ type: "text", text: TASK });
    // Order holds: the replaced images are the oldest, each note in its image's place, and
    // every image after the last note is kept.
    const shape = blocks.slice(1).map((b) => (b.type === "image" ? "image" : b.text));
    const notes = shape.filter((s) => s !== "image");
    expect(notes.length).toBeGreaterThan(0);
    expect(shape.length).toBe(5);
    expect(shape.slice(0, notes.length)).toEqual(notes.map((_, i) => imageNote(i + 1, 5)));
    expect(shape.slice(notes.length).every((s) => s === "image")).toBe(true);
    expect(shape.filter((s) => s === "image").length, "at least one image survives").toBeGreaterThan(0);
  });

  it("the newest images are the ones kept", () => {
    const task = taskTurn([{ type: "text", text: TASK }, image("1"), image("2"), image("3"), image("4"), image("5")]);
    const result = compactSession(history(task), { maxTokens: BUDGET, preserveRecent: 4 });
    const images = blocksOf(result.messages.find((m) => isTaskTurn(m))!).filter((b) => b.type === "image");
    const tags = images.map((b) => ((b as unknown as { source: { data: string } }).source.data.slice(-1)));
    expect(tags.at(-1)).toBe("5");
    expect(tags).toEqual([...tags].sort());
  });

  it("a long task text with images: the images go first, and their notes survive the text cut", () => {
    const longTask = `${TASK}\n${"shelf row moved; ".repeat(4_000)}`;
    const task = taskTurn([{ type: "text", text: longTask }, image("1"), image("2"), image("3")]);
    const result = compactSession(history(task), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    const blocks = blocksOf(result.messages.find((m) => isTaskTurn(m))!);
    expect(blocks.slice(1)).toEqual([1, 2, 3].map((n) => ({ type: "text", text: imageNote(n, 3) })));
    expect(blocks[0]!.text!.startsWith(TASK)).toBe(true);
  });

  it("a newest tool_result whose array content is one long text is cut to the budget", () => {
    const newest = arrayResultTurn([{ type: "text", text: "log line ".repeat(30_000) }]);
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    const taskKept = result.messages.find((m) => isTaskTurn(m));
    expect(taskKept!.content).toBe(TASK);
    const resultTurn = result.messages.findLast((m) => blocksOf(m).some((b) => b.type === "tool_result"));
    expect((blocksOf(resultTurn!)[0] as { tool_use_id?: string }).tool_use_id, "the newest result stays paired with its call").toBe("shot");
  });

  it("a newest tool_result carrying six screenshots fits: its oldest screenshots become notes", () => {
    const shots = [1, 2, 3, 4, 5, 6].map((n) => image(String(n)));
    const newest = arrayResultTurn([{ type: "text", text: "six views of the reading room" }, ...shots]);
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    const resultTurn = result.messages.findLast((m) => blocksOf(m).some((b) => b.type === "tool_result"))!;
    const inner = (blocksOf(resultTurn)[0]!.content as Block[]);
    expect(inner[1]).toEqual({ type: "text", text: imageNote(1, 6) });
    expect(inner.length).toBe(7);
  });

  it("a newest tool_use content block with a huge input fits", () => {
    const newest: ConversationMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "w", name: "file_write", input: { path: "a.cs", content: "x".repeat(200_000) } }] } as unknown as ConversationMessage,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "w", content: "ok" }] } as ConversationMessage,
    ];
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    expect(result.messages.find((m) => isTaskTurn(m))!.content).toBe(TASK);
  });

  it("a newest tool call whose input has many small keys fits", () => {
    const input = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`k${i}`, "v"]));
    const newest: ConversationMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "m", name: "batch_edit", input }] } as ConversationMessage,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "m", content: "ok" }] } as ConversationMessage,
    ];
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    const call = result.messages.find((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
    expect(call, "the call stays paired with its result").toBeDefined();
  });
});
