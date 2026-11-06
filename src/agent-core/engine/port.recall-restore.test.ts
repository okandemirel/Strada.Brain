/**
 * The port's trim and compaction both drop turns from the head of the
 * history. A memory refresh's recall rides in one of those turns, and the
 * refresher never recalls the same content twice, so after either the port
 * puts the run's dropped recalls back on the turn about to be sent
 * (recall-ledger.ts).
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentCorePort, type PortDeps } from "./port.js";
import type { AgentEngine } from "./agent-engine.js";
import { RecallLedger } from "../../agents/recall-ledger.js";
import type { ConversationMessage } from "../../agents/providers/provider-core.interface.js";

const RECALL = "## Recalled during this task\n\nThe ferry timetable is in harbour.csv.";

function harness() {
  const session = { messages: [] as ConversationMessage[] };
  const recallLedger = new RecallLedger();
  const runCtx = { chatId: "chat-1", identityKey: "user-1", session, recallLedger };
  // Stand-ins that drop the head of the history the way trimSession and compactSession do.
  const engine = {
    setupAgentCoreRun: vi.fn(async () => ({ runCtx, setup: {} })),
    trimContextWindowForRun: vi.fn((s: { messages: ConversationMessage[] }) => {
      s.messages.splice(0, s.messages.length - 1);
    }),
    buildPolicySeed: () => ({}),
  } as unknown as AgentEngine;
  const deps = {
    maybeCompactSession: vi.fn((s: { messages: ConversationMessage[] }) => {
      s.messages = [{ role: "user", content: "[Compacted conversation summary]" }, ...s.messages.slice(-1)];
    }),
    getTaskExecutionContext: () => undefined,
    monitorLifecycle: () => undefined,
    createGateway: () => ({}),
  } as unknown as PortDeps;
  const { port } = createAgentCorePort(engine, deps);
  return { port, session, recallLedger };
}

/** A history whose recall sits in an old turn, ending on the tool-result turn about to be sent. */
function historyWithOldRecall(recallLedger: RecallLedger): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ role: "user", content: "Plan the crossing" }];
  recallLedger.add(messages, RECALL);
  messages.push(
    { role: "assistant", content: "Reading", tool_calls: [{ id: "c1", name: "file_read", input: {} }] } as ConversationMessage,
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } as unknown as ConversationMessage,
  );
  return messages;
}

describe("the port puts a dropped recall back", () => {
  it("after the context-window trim", async () => {
    const h = harness();
    await h.port.setupRun({ chatId: "chat-1" } as never);
    h.session.messages = historyWithOldRecall(h.recallLedger);

    h.port.trimContextWindow(h.session, "background");

    expect(h.session.messages).toHaveLength(1);
    expect(JSON.stringify(h.session.messages[0])).toContain("harbour.csv");
  });

  it("after compaction", async () => {
    const h = harness();
    await h.port.setupRun({ chatId: "chat-1" } as never);
    h.session.messages = historyWithOldRecall(h.recallLedger);

    h.port.maybeCompactSession(h.session, "mock", "default", "sys", 0);

    expect(h.session.messages).toHaveLength(2);
    expect(JSON.stringify(h.session.messages.at(-1))).toContain("harbour.csv");
  });
});
