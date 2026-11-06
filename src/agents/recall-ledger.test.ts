/**
 * The recall ledger keeps a mid-run memory recall in front of the model for
 * the rest of the run, and out of what memory stores (recall-ledger.ts).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { keepRecalls, RecallLedger, withoutRecalledMemory } from "./recall-ledger.js";
import { SessionManager, type Session, type SessionManagerDeps } from "./orchestrator-session-manager.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { ConversationMessage } from "./providers/provider-core.interface.js";
import { compactSession } from "./session-compaction.js";
import { createLogger } from "../utils/logger.js";

const RECALL = "## Recalled during this task\n\n## Relevant Memory\nThe kiln schedule lives in kilns.toml.";

function sessionManager(memoryManager?: Partial<IMemoryManager>): SessionManager {
  return new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn().mockReturnValue(undefined) },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
    ...(memoryManager ? { memoryManager: memoryManager as IMemoryManager } : {}),
  } as unknown as SessionManagerDeps);
}

/** One tool step as the loop stores it: the assistant's call, then the user turn holding its result. */
function toolStep(n: number): ConversationMessage[] {
  return [
    { role: "assistant", content: `Reading glaze ${n}`, tool_calls: [{ id: `c${n}`, name: "file_read", input: { path: `glaze-${n}.md` } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `c${n}`, content: `glaze ${n} notes` }] },
  ] as unknown as ConversationMessage[];
}

const text = (messages: readonly ConversationMessage[]): string => JSON.stringify(messages);

describe("RecallLedger", () => {
  beforeAll(() => createLogger("error", "test.log"));

  it("appends a recall to the turn about to be sent, inside its markers", () => {
    const ledger = new RecallLedger();
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }, ...toolStep(1)];
    ledger.add(messages, RECALL);

    expect(messages).toHaveLength(3);
    const last = messages.at(-1)!.content as Array<{ type: string; text?: string }>;
    expect(last[0]!.type).toBe("tool_result");
    expect(last[1]!.text).toMatch(/^<!-- strada:recall \S+#1 -->\n## Recalled during this task/);
    expect(last[1]!.text).toMatch(/<!-- \/strada:recall \S+#1 -->$/);
  });

  it("keeps the recall in front of the model through 64 tool steps trimmed at a 40-message cap", () => {
    const ledger = new RecallLedger();
    const sm = sessionManager();
    const session = { messages: [{ role: "user", content: "Fire the next batch" }] } as unknown as Session;
    let trims = 0;
    for (let step = 1; step <= 64; step++) {
      session.messages.push(...toolStep(step));
      if (step === 3) ledger.add(session.messages, RECALL);
      // What the port does before every call: trim, then restore.
      if (sm.trimSession(session, 40).length > 0) trims++;
      ledger.restore(session.messages);
      if (step >= 3) expect(text(session.messages)).toContain("kilns.toml");
    }
    expect(trims).toBeGreaterThan(0);
    // Restored once per trim that dropped it, never piled up.
    expect(text(session.messages).split("kilns.toml").length - 1).toBe(1);
  });

  it("changes nothing while the history still holds the recall, so earlier requests stay a prefix", () => {
    const ledger = new RecallLedger();
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }, ...toolStep(1)];
    ledger.add(messages, RECALL);
    messages.push(...toolStep(2));
    const before = text(messages);

    expect(ledger.restore(messages)).toBe(0);
    expect(text(messages)).toBe(before);
  });

  it("puts back a recall that compaction summarized away, on the newest turn", () => {
    const ledger = new RecallLedger();
    let messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }, ...toolStep(1)];
    ledger.add(messages, RECALL);
    for (let step = 2; step <= 12; step++) messages.push(...toolStep(step));
    const result = compactSession(messages, { maxTokens: 200, preserveRecent: 4, maxGroups: 20 });
    expect(result.compacted).toBe(true);
    messages = result.messages as ConversationMessage[];
    expect(text(messages)).not.toContain("kilns.toml");

    expect(ledger.restore(messages)).toBe(1);
    expect(JSON.stringify(messages.at(-1))).toContain("kilns.toml");
  });

  it("counts a recall that compaction cut short as held", () => {
    const ledger = new RecallLedger();
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }];
    ledger.add(messages, RECALL);
    const content = messages[0]!.content as string;
    messages[0] = { role: "user", content: content.slice(0, content.indexOf("kilns")) + "\n[… truncated to fit the context window]" };

    expect(ledger.restore(messages)).toBe(0);
  });

  it("opens a user turn for the recall when a trim left the history empty, and waits while a tool result is due", () => {
    const ledger = new RecallLedger();
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }];
    ledger.add(messages, RECALL);
    messages.splice(0);
    expect(ledger.restore(messages)).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(text(messages)).toContain("kilns.toml");

    const awaiting = toolStep(2).slice(0, 1);
    expect(ledger.restore(awaiting)).toBe(0);
    expect(awaiting).toHaveLength(1);
    awaiting.push(toolStep(2)[1]!);
    expect(ledger.restore(awaiting)).toBe(1);
  });

  it("does not take another run's recall with the same number for its own", () => {
    const earlierRun = new RecallLedger();
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }];
    earlierRun.add(messages, "## Recalled during this task\n\nan older note");
    const thisRun = new RecallLedger();
    thisRun.add([{ role: "assistant", content: "x", tool_calls: [{ id: "c", name: "n", input: {} }] } as ConversationMessage], RECALL);

    expect(thisRun.restore(messages)).toBe(1);
    expect(text(messages)).toContain("kilns.toml");
  });

  it("stops restoring the oldest recalls past its budget, never the newest", () => {
    const ledger = new RecallLedger(300);
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }];
    ledger.add(messages, `first ${"a".repeat(150)}`);
    ledger.add(messages, `second ${"b".repeat(150)}`);
    ledger.add(messages, `third ${"c".repeat(400)}`);
    messages.splice(0, 1, { role: "user", content: "Fire the next batch" });

    expect(ledger.restore(messages)).toBe(1);
    expect(text(messages)).toContain("third");
    expect(text(messages)).not.toContain("second");
  });
});

describe("keepRecalls (the compaction before a hard-timeout retry, with no ledger at hand)", () => {
  it("puts back each recall the compaction dropped, once, and leaves alone one it kept", () => {
    const ledger = new RecallLedger();
    const history: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }, ...toolStep(1)];
    ledger.add(history, RECALL);
    for (let step = 2; step <= 12; step++) history.push(...toolStep(step));
    ledger.add(history, "## Recalled during this task\n\nThe glaze cools for six hours.");
    const result = compactSession(history, { maxTokens: 200, preserveRecent: 4, maxGroups: 20 });
    expect(result.compacted).toBe(true);
    const compacted = result.messages as ConversationMessage[];
    expect(text(compacted)).not.toContain("kilns.toml");
    expect(text(compacted)).toContain("six hours");

    expect(keepRecalls(history, compacted)).toBe(1);
    expect(JSON.stringify(compacted.at(-1))).toContain("kilns.toml");
    expect(text(compacted).split("six hours").length - 1).toBe(1);
    // Nothing left to carry: a second pass changes nothing.
    expect(keepRecalls(history, compacted)).toBe(0);
  });

  it("closes a recall an earlier compaction cut, so the user's words after it are not taken for recall", () => {
    const ledger = new RecallLedger();
    const history: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }];
    ledger.add(history, RECALL);
    const content = history[0]!.content as string;
    history[0] = { role: "user", content: content.slice(0, content.indexOf("kilns") + 5) };
    const compacted: ConversationMessage[] = [{ role: "user", content: "Then glaze the second shelf" }];

    expect(keepRecalls(history, compacted)).toBe(1);
    expect(JSON.stringify(compacted)).toContain("kilns");
    compacted[0] = { role: "user", content: `${compacted[0]!.content as string}\n\nAlso check the vents` };
    expect(withoutRecalledMemory(compacted)[0]!.content).toBe("Then glaze the second shelf\n\nAlso check the vents");
  });
});

describe("withoutRecalledMemory", () => {
  it("takes every marked recall out of string and block content, and changes nothing else", () => {
    const ledger = new RecallLedger();
    const plain: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }];
    ledger.add(plain, RECALL);
    const blocks: ConversationMessage[] = toolStep(1);
    ledger.add(blocks, RECALL);
    const cut: ConversationMessage = { role: "user", content: "Glaze notes\n\n<!-- strada:recall ab12cd34#9 -->\n## Recalled during this task\nkilns.to" };
    const untouched: ConversationMessage = { role: "assistant", content: "Batch two is ready." };
    const input = [...plain, ...blocks, cut, untouched];
    const before = text(input);

    const stored = withoutRecalledMemory(input);

    expect(text(stored)).not.toContain("kilns");
    expect(text(stored)).not.toContain("strada:recall");
    expect(stored[0]!.content).toBe("Fire the next batch");
    expect(stored[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "glaze 1 notes" }]);
    expect(stored[3]!.content).toBe("Glaze notes");
    expect(stored[4]).toBe(untouched);
    expect(text(input)).toBe(before);
  });

  it("is what persistSessionToMemory hands to memory", async () => {
    const storeConversation = vi.fn().mockResolvedValue({ kind: "ok", value: undefined });
    const sm = sessionManager({ storeConversation } as unknown as Partial<IMemoryManager>);
    const messages: ConversationMessage[] = [{ role: "user", content: "Fire the next batch" }, ...toolStep(1)];
    new RecallLedger().add(messages, RECALL);
    messages.push({ role: "assistant", content: "Batch fired." });

    await sm.persistSessionToMemory("chat-kiln", messages, true);

    expect(storeConversation).toHaveBeenCalledTimes(1);
    const [, transcript, fields] = storeConversation.mock.calls[0]!;
    expect(transcript).toContain("Fire the next batch");
    expect(transcript).toContain("Batch fired.");
    expect(transcript).not.toContain("kilns.toml");
    expect(JSON.stringify(fields)).not.toContain("kilns.toml");
  });
});
