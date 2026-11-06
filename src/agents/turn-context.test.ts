/**
 * The turn context rides at the end of a call's last user turn and never enters the stored
 * history, so the system prompt stays the same bytes from call to call and the provider's prefix
 * cache reaches the history (turn-context.ts).
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { TURN_CONTEXT_HEADER, appendToLastUserTurn, composeTurnContext, withTurnContext } from "./turn-context.js";

const task: ConversationMessage = { role: "user", content: "Write notes/a.txt" };
const reply: ConversationMessage = {
  role: "assistant",
  content: "",
  tool_calls: [{ id: "c1", name: "file_write", input: { path: "notes/a.txt" } }],
};
const results: ConversationMessage = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "c1", content: "File written" }],
};

describe("composeTurnContext", () => {
  it("is empty when every section is blank, so a call without one sends nothing extra", () => {
    expect(composeTurnContext([undefined, "", "  \n\n "])).toBe("");
  });

  it("puts the header first and keeps the sections in order, trimmed", () => {
    const context = composeTurnContext(["\n\n## Current Plan\n1. write", undefined, "\n\n## Orchestrator Assignment\nrole\n"]);
    expect(context).toBe(`${TURN_CONTEXT_HEADER}\n\n## Current Plan\n1. write\n\n## Orchestrator Assignment\nrole`);
  });
});

describe("withTurnContext", () => {
  it("returns the history itself when there is no context", () => {
    const history = [task];
    expect(withTurnContext(history, undefined)).toBe(history);
    expect(withTurnContext(history, "")).toBe(history);
  });

  it("appends the context after a text turn, leaving the stored history untouched", () => {
    const history = [task];
    const sent = withTurnContext(history, "CTX");
    expect(sent).toEqual([{ role: "user", content: "Write notes/a.txt\n\nCTX" }]);
    expect(history).toEqual([{ role: "user", content: "Write notes/a.txt" }]);
    expect(sent[0]).not.toBe(task);
  });

  it("appends the context after the tool results, which keep their place and their bytes", () => {
    const history = [task, reply, results];
    const sent = withTurnContext(history, "CTX");
    expect(sent.slice(0, 2)).toEqual([task, reply]);
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "File written" },
        { type: "text", text: "CTX" },
      ],
    });
    expect(results.content).toHaveLength(1);
  });

  it("gives a conversation that ends on the assistant a user turn holding only the context", () => {
    const history = [task, { role: "assistant", content: "Plan: write it" } as ConversationMessage];
    expect(withTurnContext(history, "CTX")).toEqual([...history, { role: "user", content: "CTX" }]);
    expect(withTurnContext([], "CTX")).toEqual([{ role: "user", content: "CTX" }]);
  });

  it("keeps every earlier request a prefix of the next: only the context moves", () => {
    const history: ConversationMessage[] = [task];
    const first = withTurnContext(history, "iteration 1");
    history.push(reply, results);
    const second = withTurnContext(history, "iteration 2");
    // The first call's history, without its context, is where the second call starts.
    expect(second.slice(0, 1)).toEqual(history.slice(0, 1));
    expect(first[0]).not.toEqual(second[0]);
    expect(JSON.stringify(second).startsWith(JSON.stringify(history.slice(0, 1)).slice(0, -1))).toBe(true);
  });
});

describe("appendToLastUserTurn", () => {
  it("adds the text to the stored history at the turn about to be sent", () => {
    const history = [task, reply, results];
    expect(appendToLastUserTurn(history, "## Recalled during this task\nmemory M")).toBe(true);
    expect(history[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "File written" },
        { type: "text", text: "## Recalled during this task\nmemory M" },
      ],
    });
    // The earlier turns are the same objects: nothing already sent changed.
    expect(history[0]).toBe(task);
    expect(history[1]).toBe(reply);
  });

  it("appends to a text turn as text", () => {
    const history: ConversationMessage[] = [{ role: "user", content: "[VERIFY] run the build" }];
    expect(appendToLastUserTurn(history, "recall")).toBe(true);
    expect(history[0]).toEqual({ role: "user", content: "[VERIFY] run the build\n\nrecall" });
  });

  it("changes nothing when the history does not end on a user turn, or the text is empty", () => {
    const history = [task, reply];
    expect(appendToLastUserTurn(history, "recall")).toBe(false);
    expect(history).toEqual([task, reply]);
    expect(appendToLastUserTurn([task], "")).toBe(false);
    expect(appendToLastUserTurn([], "recall")).toBe(false);
  });
});
