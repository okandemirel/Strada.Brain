/**
 * Compaction keeps the run's task turn verbatim (board #63).
 *
 * Measured on task/58-1 by calling compactSession directly: task + 15 tool pairs + assistant
 * text + a plain-text gate turn + 15 tool pairs, maxTokens 1500, preserveRecent 6, left the GATE
 * as the kept user turn and the task only in the summary's 800-char "Original user request"
 * preview. Stages 2-4 picked "the newest user turn" and could not tell a gate the loop wrote from
 * the task. They now keep the newest TaskTurn (orchestrator-session-manager-task-turn.ts); a
 * history without one keeps the newest user turn someone wrote, never a SystemTurn gate.
 */

import { describe, it, expect } from "vitest";
import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { compactSession, estimateTokens } from "./session-compaction.js";
import { taskTurn, isTaskTurn } from "./orchestrator-session-manager-task-turn.js";
import { pushSystemTurn } from "./orchestrator-session-manager-last-user.js";

const TASK = "Rename the library loan columns to the new catalogue names and keep the old CSV export working.";
const GATE = "You stopped without finishing. Continue the task: run the remaining steps, then report.";

function toolPairs(prefix: string, count: number, resultChars = 400): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    out.push({ role: "assistant", content: "", tool_calls: [{ id, name: "file_read", input: { path: `src/${id}.ts` } }] } as ConversationMessage);
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${id}: `.padEnd(resultChars, "r") }] } as ConversationMessage);
  }
  return out;
}

/** The #58 measurement's shape. `gate` decides how the gate turn is written. */
function history(task: ConversationMessage, gate: "plain" | "system"): ConversationMessage[] {
  const messages: ConversationMessage[] = [task, ...toolPairs("a", 15), { role: "assistant", content: "First pass done; checking the export next." }];
  if (gate === "plain") messages.push({ role: "user", content: GATE });
  else pushSystemTurn(messages, GATE);
  messages.push(...toolPairs("b", 15));
  return messages;
}

function textOf(message: ConversationMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** The user turns of a compacted history that are neither tool results nor the compaction note. */
function keptUserTexts(messages: readonly ConversationMessage[]): string[] {
  return messages.filter((m) => m.role === "user" && textOf(m).length > 0).map(textOf);
}

describe("compaction keeps the run's task turn (board #63)", () => {
  it("stage 2 keeps the TaskTurn verbatim, not the plain-text gate after it", () => {
    const result = compactSession(history(taskTurn(TASK), "plain"), { maxTokens: 1500, preserveRecent: 6 });

    expect(result.stageApplied).toBe("summarization");
    const kept = result.messages.find((m) => isTaskTurn(m));
    expect(kept, "the task turn is in the history").toBeDefined();
    expect(kept!.content).toBe(TASK);
    // The gate was older than the preserved tail: it is summarized, not kept.
    expect(keptUserTexts(result.messages)).not.toContain(GATE);
  });

  it("stage 3 (sliding window) keeps the TaskTurn verbatim", () => {
    // preserveRecent 40 leaves stage 2 nothing to do, so the window is what cuts.
    const result = compactSession(history(taskTurn(TASK), "plain"), { maxTokens: 1500, preserveRecent: 40, maxGroups: 6 });

    expect(result.stageApplied).toBe("sliding_window");
    expect(result.messages.find((m) => isTaskTurn(m))?.content).toBe(TASK);
    expect(keptUserTexts(result.messages)).not.toContain(GATE);
  });

  it("stage 4 (hard truncation) pins the TaskTurn, not the gate", () => {
    const result = compactSession(history(taskTurn(TASK), "plain"), { maxTokens: 400, preserveRecent: 40, maxGroups: 40 });

    expect(result.stageApplied).toBe("hard_truncation");
    expect(result.messages.find((m) => isTaskTurn(m))?.content).toBe(TASK);
    expect(result.finalTokens).toBeLessThanOrEqual(400);
  });

  it("a newer TaskTurn (the person's follow-up) is the one kept", () => {
    const followUp = "Also keep the legacy column names as aliases for one release.";
    const messages = [...history(taskTurn(TASK), "plain"), taskTurn(followUp), ...toolPairs("c", 8)];
    const result = compactSession(messages, { maxTokens: 1500, preserveRecent: 6 });

    expect(result.messages.find((m) => isTaskTurn(m))?.content).toBe(followUp);
  });

  it("a SystemTurn gate is not kept as the task even in a history without TaskTurns", () => {
    const result = compactSession(history({ role: "user", content: TASK }, "system"), { maxTokens: 1500, preserveRecent: 6 });

    expect(result.stageApplied).toBe("summarization");
    expect(keptUserTexts(result.messages)).toContain(TASK);
    expect(keptUserTexts(result.messages)).not.toContain(GATE);
  });

  it("an unmarked history still keeps its newest user turn someone wrote (today's behaviour)", () => {
    const result = compactSession(history({ role: "user", content: TASK }, "plain"), { maxTokens: 1500, preserveRecent: 6 });

    expect(result.stageApplied).toBe("summarization");
    expect(keptUserTexts(result.messages)).toContain(GATE);
    expect(keptUserTexts(result.messages)).not.toContain(TASK);
  });
});

describe("a task turn too large for the budget (board #63, steer 4)", () => {
  it("a long-text task is shortened to fit, keeps its mark, and the result stays within maxTokens", () => {
    const longTask = `${TASK} `.padEnd(12_000, "detail ");
    const result = compactSession(history(taskTurn(longTask), "plain"), { maxTokens: 1500, preserveRecent: 6 });

    // Stages 2-3 keep the task verbatim, so it alone overruns the budget and stage 4 shortens it.
    expect(result.stageApplied).toBe("hard_truncation");
    expect(result.finalTokens).toBeLessThanOrEqual(1500);
    const kept = result.messages.find((m) => isTaskTurn(m));
    expect(kept, "the shortened task keeps its TaskTurn mark").toBeDefined();
    expect(textOf(kept!).startsWith(TASK)).toBe(true);
    expect(textOf(kept!)).toContain("truncated to fit the context window");
    expect(keptUserTexts(result.messages)).not.toContain(GATE);
  });

  it("an image task is kept whole with its image when it fits the budget", () => {
    const imageTask = taskTurn([
      { type: "text", text: TASK },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
    const result = compactSession(history(imageTask, "plain"), { maxTokens: 3000, preserveRecent: 6 });

    expect(result.finalTokens).toBeLessThanOrEqual(3000);
    const kept = result.messages.find((m) => isTaskTurn(m));
    expect(kept).toBeDefined();
    expect(Array.isArray(kept!.content) && kept!.content.some((b) => b.type === "image")).toBe(true);
    expect(textOf(kept!)).toBe(TASK);
  });

  it("an image task larger than the whole budget: the text is cut, the image stays, and the result overruns (recorded)", () => {
    // An image counts a fixed 1600 tokens and shrinkGroup cannot cut it. With a budget under
    // that, the pinned task alone exceeds it: compaction returns the task with its text cut to
    // the marker and its image intact, over budget. This pins that behaviour as evidence; it is
    // the provider's request that fails then, not a silent loss of the task.
    const imageTask = taskTurn([
      { type: "text", text: TASK },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
    const result = compactSession(history(imageTask, "plain"), { maxTokens: 1000, preserveRecent: 6 });

    expect(result.stageApplied).toBe("hard_truncation");
    const kept = result.messages.find((m) => isTaskTurn(m));
    expect(kept).toBeDefined();
    expect(Array.isArray(kept!.content) && kept!.content.some((b) => b.type === "image")).toBe(true);
    expect(result.finalTokens).toBeGreaterThan(1000);
    expect(estimateTokens([kept!])).toBeGreaterThanOrEqual(1600);
  });
});
