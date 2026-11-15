/**
 * Stage 4 shares the budget among its pinned turns by need (board #77).
 *
 * Measured in #76 by calling compactSession directly: when the pinned turns (the task and the
 * newest group) did not fit, stage 4 gave them half the budget whatever the summary held, and
 * split that half equally. With an 8000-token target a newest tool result of six screenshots kept
 * one of them and the result came back at 1663 tokens, 80% of the budget empty. The same split
 * cut a long text turn to a quarter of the budget while the small task left its quarter unused.
 */

import { describe, it, expect } from "vitest";
import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { COMPACTION_TARGET_FLOOR_TOKENS, compactSession, estimateTokens } from "./session-compaction.js";
import { taskTurn, isTaskTurn } from "./orchestrator-session-manager-task-turn.js";

const TASK = "Compare the harbour crane layouts in these captures and list every crane that moved.";
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

function history(task: ConversationMessage, newest: ConversationMessage[]): ConversationMessage[] {
  return [task, ...toolPairs("a", 6), { role: "assistant", content: "Read the layout; comparing next." }, ...newest];
}

function blocksOf(message: ConversationMessage): Block[] {
  return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

function resultCall(id: string, content: unknown): ConversationMessage[] {
  return [
    { role: "assistant", content: "", tool_calls: [{ id, name: "unity_screenshot", input: {} }] } as ConversationMessage,
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } as ConversationMessage,
  ];
}

function newestResult(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const at = messages.findLastIndex((m) => blocksOf(m).some((b) => b.type === "tool_result"));
  return messages.slice(at - 1, at + 1);
}

describe("stage 4 shares the budget among pinned turns by need (board #77)", () => {
  it("a newest result of six screenshots keeps more than one of them within 8000 tokens", () => {
    const shots = [1, 2, 3, 4, 5, 6].map((n) => image(String(n)));
    const newest = resultCall("shot", [{ type: "text", text: "six views of the harbour" }, ...shots]);
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.stageApplied).toBe("hard_truncation");
    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    const inner = blocksOf(newestResult(result.messages)[1]!)[0]!.content as Block[];
    expect(inner.filter((b) => b.type === "image").length).toBeGreaterThan(1);
    expect(result.finalTokens, "the budget is used, not left mostly empty").toBeGreaterThan(BUDGET / 2);
    expect(result.messages.find((m) => isTaskTurn(m))!.content).toBe(TASK);
  });

  it("text only: what the small task leaves passes to the long newest result", () => {
    const longText = "crane 7 moved two berths west; ".repeat(8_000);
    const newest = resultCall("log", longText);
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    expect(result.messages.find((m) => isTaskTurn(m))!.content).toBe(TASK);
    const kept = newestResult(result.messages);
    expect((blocksOf(kept[1]!)[0] as { tool_use_id?: string }).tool_use_id).toBe("log");
    // An equal split of half the budget left the long result a quarter of it.
    expect(estimateTokens(kept)).toBeGreaterThan(BUDGET / 2);
  });

  it("text only, both pinned turns long: neither takes the other's share", () => {
    const longTask = `${TASK}\n${"berth survey row; ".repeat(8_000)}`;
    const newest = resultCall("log", "crane 7 moved two berths west; ".repeat(8_000));
    const result = compactSession(history(taskTurn(longTask), newest), { maxTokens: BUDGET, preserveRecent: 4 });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    const task = result.messages.find((m) => isTaskTurn(m))!;
    expect(String(task.content).startsWith(TASK)).toBe(true);
    const taskTokens = estimateTokens([task]);
    const newestTokens = estimateTokens(newestResult(result.messages));
    expect(taskTokens).toBeGreaterThan(BUDGET / 5);
    expect(newestTokens).toBeGreaterThan(BUDGET / 5);
  });

  it("a small summary stays whole while the pinned turns take the rest", () => {
    const summary = "Earlier: the crane survey started at berth 1.";
    const newest = resultCall("log", "crane 7 moved two berths west; ".repeat(8_000));
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: BUDGET, preserveRecent: 4, previousSummary: summary });

    expect(result.finalTokens).toBeLessThanOrEqual(BUDGET);
    expect(result.summary).toContain(summary);
    expect(estimateTokens(newestResult(result.messages))).toBeGreaterThan(BUDGET / 2);
  });

  it("a summary that really fills the budget still keeps half of it", () => {
    const budget = 4_000;
    const summary = "Earlier survey detail. ".repeat(520); // ≈ 3000 tokens, under the rolling cap
    const newest = resultCall("log", "crane 7 moved two berths west; ".repeat(8_000));
    const result = compactSession(history(taskTurn(TASK), newest), { maxTokens: budget, preserveRecent: 4, previousSummary: summary });

    expect(result.finalTokens).toBeLessThanOrEqual(budget);
    expect(estimateTokens([{ role: "system", content: result.summary ?? "" }] as never)).toBeGreaterThanOrEqual(budget / 2 - 50);
    expect(estimateTokens(newestResult(result.messages))).toBeLessThanOrEqual(budget / 2);
  });
});
