import { describe, it, expect } from "vitest";
import type { ConversationMessage } from "./providers/provider-core.interface.ts";
import type { CompactableMessage } from "./session-compaction.ts";
import {
  compactSession,
  estimateTokens,
  dropOrphanToolMessages,
  capRollingSummary,
  MAX_ROLLING_SUMMARY_CHARS,
} from "./session-compaction.ts";

describe("estimateTokens", () => {
  it("estimateTokens includes system prompt overhead when provided", () => {
    const messages: CompactableMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const withoutOverhead = estimateTokens(messages);
    const withOverhead = estimateTokens(messages, 40000);
    expect(withOverhead).toBeGreaterThan(withoutOverhead);
    expect(withOverhead - withoutOverhead).toBe(Math.ceil(40000 / 4));
  });

  it("estimateTokens returns 0 for empty messages and no system prompt", () => {
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens([], 0)).toBe(0);
  });

  it("estimateTokens counts only system prompt when messages are empty", () => {
    expect(estimateTokens([], 4000)).toBe(1000);
  });
});

/** Builds an alternating user/assistant conversation with fixed-size contents. */
function buildConversation(count: number, charsPerMessage: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i): ConversationMessage =>
    i % 2 === 0
      ? { role: "user", content: `u${i}-`.padEnd(charsPerMessage, "x") }
      : { role: "assistant", content: `a${i}-`.padEnd(charsPerMessage, "y") },
  );
}

describe("compactSession", () => {
  it("returns compacted: false and untouched messages when under budget", () => {
    // Type-level assertion: plain ConversationMessage[] is accepted with no casts.
    const messages: ConversationMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = compactSession(messages, { maxTokens: 1000 });
    expect(result.compacted).toBe(false);
    expect(result.stageApplied).toBeNull();
    expect(result.messages).toEqual(messages);
    expect(result.summary).toBeUndefined();
  });

  it("returns system-free messages and a summary when stage 2 (summarization) runs", () => {
    const messages = buildConversation(20, 400); // ~2000 tokens
    const result = compactSession(messages, { maxTokens: 1500 });
    expect(result.compacted).toBe(true);
    expect(result.stageApplied).toBe("summarization");
    expect(result.messages.every((m) => String(m.role) !== "system")).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain("Compacted conversation summary");
    // The 4 most recent messages survive summarization
    expect(result.messages).toEqual(messages.slice(-4));
  });

  it("merges previousSummary into the returned summary", () => {
    const messages = buildConversation(20, 400);
    const result = compactSession(messages, {
      maxTokens: 1500,
      previousSummary: "old summary",
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("old summary");
    expect(result.messages.every((m) => String(m.role) !== "system")).toBe(true);
  });

  it("round-trips previousSummary unchanged when no compaction occurs", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "reply" },
    ];
    const result = compactSession(messages, {
      maxTokens: 1000,
      previousSummary: "keep me",
    });
    expect(result.compacted).toBe(false);
    expect(result.summary).toBe("keep me");
    expect(result.messages).toEqual(messages);
  });

  it("counts previousSummary toward the budget on the early-return path", () => {
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const withSummary = compactSession(messages, {
      maxTokens: 1000,
      previousSummary: "s".repeat(400),
    });
    const withoutSummary = compactSession(messages, { maxTokens: 1000 });
    expect(withSummary.originalTokens).toBeGreaterThan(withoutSummary.originalTokens);
  });

  it("stage-4 hard truncation still returns a system-free messages array", () => {
    // 10 big messages followed by 2 tiny ones: summarization cannot fit the
    // budget (kept recents are too big), so the pipeline falls through to
    // hard truncation, which keeps only the tiny recent messages.
    const big = buildConversation(10, 2000);
    const tiny: ConversationMessage[] = [
      { role: "user", content: "tiny user question" },
      { role: "assistant", content: "tiny answer" },
    ];
    const messages = [...big, ...tiny];
    const result = compactSession(messages, { maxTokens: 500 });
    expect(result.compacted).toBe(true);
    expect(result.stageApplied).toBe("hard_truncation");
    expect(result.messages.every((m) => String(m.role) !== "system")).toBe(true);
    expect(result.messages).toEqual(tiny);
    expect(result.summary).toBeTruthy();
    expect(result.finalTokens).toBeLessThanOrEqual(500);
  });
});

describe("rolling summary growth bound (BUG 1)", () => {
  it("keeps compactionSummary <= MAX_ROLLING_SUMMARY_CHARS and preserves the original-request header across 30+ stage-2 compactions", () => {
    // Drive many stage-2 compactions, feeding each result.summary back as
    // previousSummary the way orchestrator.maybeCompactSession does. Without the
    // cap, the rolling summary grows ~3.2KB per cycle until it wipes history.
    let rollingSummary: string | undefined;
    let maxObservedLength = 0;
    for (let cycle = 0; cycle < 35; cycle++) {
      // Fresh oversized conversation each cycle to force stage-2 summarization.
      const messages = buildConversation(20, 400); // ~2000 tokens
      const result = compactSession(messages, {
        maxTokens: 1500,
        previousSummary: rollingSummary,
      });
      expect(result.compacted).toBe(true);
      rollingSummary = result.summary;
      expect(rollingSummary).toBeTruthy();
      maxObservedLength = Math.max(maxObservedLength, rollingSummary!.length);
    }

    expect(rollingSummary!.length).toBeLessThanOrEqual(MAX_ROLLING_SUMMARY_CHARS);
    expect(maxObservedLength).toBeLessThanOrEqual(MAX_ROLLING_SUMMARY_CHARS);
    // The original-request header survives head+tail truncation.
    expect(rollingSummary).toContain("Original user request");
  });

  it("capRollingSummary preserves head and tail with a middle-elision marker", () => {
    const head = "HEAD-Original user request: do the thing.";
    const tail = "TAIL-most recent summary detail.";
    const big = head + "M".repeat(MAX_ROLLING_SUMMARY_CHARS * 2) + tail;
    const capped = capRollingSummary(big);
    expect(capped.length).toBeLessThanOrEqual(MAX_ROLLING_SUMMARY_CHARS);
    expect(capped.startsWith("HEAD-Original user request")).toBe(true);
    expect(capped.endsWith("TAIL-most recent summary detail.")).toBe(true);
    expect(capped).toContain("older summary detail truncated");
  });

  it("capRollingSummary returns short summaries unchanged", () => {
    expect(capRollingSummary("keep me")).toBe("keep me");
  });
});

describe("stage-4 budget guarantee (BUG 1)", () => {
  it("never returns a prompt exceeding maxTokens even when the summary alone is oversized, and keeps fitting conversation", () => {
    // A previousSummary far larger than maxTokens forces stage-4 to confront a
    // summary that alone overruns the budget. Defensive truncation must keep the
    // returned prompt within budget while still retaining small recent messages.
    const maxTokens = 500; // ~2000 chars budget
    const hugeSummary = "Original user request:\n" + "Z".repeat(maxTokens * 4 * 3); // ~3x budget
    // Big messages that cannot be summarized into budget, plus tiny recents.
    const big = buildConversation(8, 2000);
    const tiny: ConversationMessage[] = [
      { role: "user", content: "tiny recent question" },
      { role: "assistant", content: "tiny recent answer" },
    ];
    const messages = [...big, ...tiny];
    const result = compactSession(messages, {
      maxTokens,
      previousSummary: hugeSummary,
    });
    expect(result.compacted).toBe(true);

    // The returned flat prompt (summary + messages) must be within budget.
    const flat: CompactableMessage[] = [
      ...(result.summary ? [{ role: "system" as const, content: result.summary }] : []),
      ...result.messages,
    ];
    expect(estimateTokens(flat)).toBeLessThanOrEqual(maxTokens);
    expect(result.finalTokens).toBeLessThanOrEqual(maxTokens);
  });

  it("does not drop ALL conversation when at least one message fits under budget", () => {
    // Summary fits; a single tiny message must survive alongside it.
    const maxTokens = 1000;
    const summary = "Original user request:\n" + "S".repeat(1000); // ~250 tokens
    const messages: ConversationMessage[] = [
      ...buildConversation(6, 3000), // oversized, will be dropped by stage-4
      { role: "user", content: "small surviving message" },
    ];
    const result = compactSession(messages, { maxTokens, previousSummary: summary });
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    const flat: CompactableMessage[] = [
      ...(result.summary ? [{ role: "system" as const, content: result.summary }] : []),
      ...result.messages,
    ];
    expect(estimateTokens(flat)).toBeLessThanOrEqual(maxTokens);
  });
});

describe("orphan tool-reference repair (BUG 2)", () => {
  /** Real wire shape: assistant carries tool_calls (string content), tool result is a separate user message. */
  function toolCallPair(id: string, resultSize: number): ConversationMessage[] {
    return [
      {
        role: "assistant",
        content: "calling a tool",
        tool_calls: [{ id, name: "file_read", input: { path: "/x" } }],
      } as ConversationMessage,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: "R".repeat(resultSize) },
        ],
      } as ConversationMessage,
    ];
  }

  it("dropOrphanToolMessages drops an orphaned tool_result user message", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan-1", content: "result with no call" }],
      } as ConversationMessage,
    ];
    const repaired = dropOrphanToolMessages(messages);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.content).toBe("hi");
  });

  it("dropOrphanToolMessages strips orphaned tool_calls but keeps assistant text", () => {
    const messages: ConversationMessage[] = [
      {
        role: "assistant",
        content: "assistant reasoning text",
        tool_calls: [{ id: "call-1", name: "file_read", input: {} }],
      } as ConversationMessage,
      // No matching tool_result message.
    ];
    const repaired = dropOrphanToolMessages(messages);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.role).toBe("assistant");
    expect((repaired[0] as { tool_calls?: unknown }).tool_calls).toBeUndefined();
    expect(repaired[0]!.content).toBe("assistant reasoning text");
  });

  it("dropOrphanToolMessages keeps fully-paired tool calls intact", () => {
    const messages = toolCallPair("paired-1", 20);
    const repaired = dropOrphanToolMessages(messages);
    expect(repaired).toHaveLength(2);
    expect((repaired[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
  });

  it("compactSession produces NO orphan when an oversized tool_result is dropped by stage-4", () => {
    // Real shape: assistant tool_calls (cheap) + oversized tool_result user message.
    // Stage-4 iterates per-message and skips the oversized tool_result while keeping
    // the cheap assistant tool_calls — that orphan must be repaired by compaction.
    const fillers = buildConversation(6, 1500); // pad so summarization/window run first
    const [assistantCall, oversizedResult] = toolCallPair("tc-orphan", 8000);
    const messages: ConversationMessage[] = [...fillers, assistantCall!, oversizedResult!];
    const result = compactSession(messages, { maxTokens: 500 });
    expect(result.compacted).toBe(true);

    // Collect surviving tool_call ids and tool_result ids; assert perfect pairing.
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const msg of result.messages) {
      if (msg.role === "assistant") {
        for (const tc of (msg as { tool_calls?: { id: string }[] }).tool_calls ?? []) callIds.add(tc.id);
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as { type: string }).type === "tool_result") {
            resultIds.add((block as { tool_use_id: string }).tool_use_id);
          }
        }
      }
    }
    // Every surviving tool_use has its tool_result and vice versa (no orphans).
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  });

  it("compactSession repairs the mirror case: oversized assistant tool_calls message dropped, leaving an orphan tool_result", () => {
    // Here the assistant tool_calls message is large (its tool input is huge) and
    // gets dropped while the small tool_result survives — the orphan tool_result
    // must be removed.
    const fillers = buildConversation(6, 1500);
    const assistantCall: ConversationMessage = {
      role: "assistant",
      content: "C".repeat(8000),
      tool_calls: [{ id: "tc-mirror", name: "file_read", input: {} }],
    } as ConversationMessage;
    const smallResult: ConversationMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tc-mirror", content: "ok" }],
    } as ConversationMessage;
    const messages: ConversationMessage[] = [...fillers, assistantCall, smallResult];
    const result = compactSession(messages, { maxTokens: 500 });
    expect(result.compacted).toBe(true);

    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const msg of result.messages) {
      if (msg.role === "assistant") {
        for (const tc of (msg as { tool_calls?: { id: string }[] }).tool_calls ?? []) callIds.add(tc.id);
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as { type: string }).type === "tool_result") {
            resultIds.add((block as { tool_use_id: string }).tool_use_id);
          }
        }
      }
    }
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  });
});
