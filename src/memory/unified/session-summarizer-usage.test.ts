/**
 * A session summary's tokens reach the spend counters and the cost ledger (task #71).
 *
 * SessionSummarizer called provider.chat and read only the text: the summary
 * of every ended session consumed tokens that no counter, no daily wall and
 * no cost row ever saw. These tests drive the REAL SessionSummarizer over the
 * REAL process ledger (usage-ledger-harness) and compare what the provider
 * billed with what the counters and the cost ledger recorded.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SessionSummarizer } from "./session-summarizer.js";
import type { SessionSummary } from "./session-summarizer.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { ConversationMessage } from "../../agents/providers/provider-core.interface.js";
import { estimateCostWithCache } from "../../common/cost-model.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const SUMMARY: SessionSummary = {
  summary: "The user planned a three-day orchard pruning schedule",
  keyDecisions: ["Prune the apple trees first"],
  openItems: ["Buy a new pair of loppers"],
  topics: ["orchard", "pruning"],
};

const MESSAGES: ConversationMessage[] = [
  { role: "user", content: "When should the apple trees be pruned?" },
  { role: "assistant", content: "Late winter, before the buds open." },
];

const executionStore = { updateSessionSummary: vi.fn(), updateExecutionSnapshot: vi.fn(), getMemory: vi.fn().mockReturnValue(null) } as unknown as TaskExecutionStore;

let harness: UsageLedgerHarness;
beforeEach(() => {
  vi.clearAllMocks();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

describe("SessionSummarizer bills the summary call (task #71)", () => {
  it("a summary reply with usage reaches the counters and books one ledger row under daemon", async () => {
    const provider = scriptedProvider("deepseek", [{ text: JSON.stringify(SUMMARY), usage: usage(4200, 380) }]);
    const result = await new SessionSummarizer(provider, executionStore).summarize("chat-1", MESSAGES);

    expect(result.summary).toBe(SUMMARY.summary); // the call ran and parsed: this is the real path
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(harness.counted()).toEqual({ input: 4200, output: 380, dailyTokens: 4580 });
    expect(harness.booked).toHaveLength(1);
    const row = harness.booked[0]!;
    expect(row.source).toBe("daemon");
    expect(row.metadata).toMatchObject({ triggerName: "session-summary", tokensIn: 4200, tokensOut: 380 });
    expect(row.amount).toBeGreaterThan(0);
    expect(row.amount).toBe(estimateCostWithCache({ inputTokens: 4200, outputTokens: 380 }, "deepseek"));
  });

  it("a reply from a free model is counted but books no cost row", async () => {
    // The harness's scriptedProvider cannot say who served the call: build the chain-style reply inline.
    const provider = {
      name: "opencode",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async () => ({
        text: JSON.stringify(SUMMARY),
        toolCalls: [],
        stopReason: "end_turn",
        usage: usage(3000, 250),
        servedBy: { provider: "opencode", model: "glm-5.3-free" },
      })),
    } as unknown as IAIProvider;
    const result = await new SessionSummarizer(provider, executionStore).summarize("chat-1", MESSAGES);

    expect(result.summary).toBe(SUMMARY.summary);
    expect(harness.counted()).toMatchObject({ input: 3000, output: 250, dailyTokens: 3250 });
    expect(harness.booked).toEqual([]);
  });

  it("a reply without usage books nothing, counts nothing, and says so", async () => {
    const provider = scriptedProvider("deepseek", [{ text: JSON.stringify(SUMMARY) }]);
    const result = await new SessionSummarizer(provider, executionStore).summarize("chat-1", MESSAGES);

    expect(result.summary).toBe(SUMMARY.summary);
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call usage not measured — nothing billed for this call",
      expect.objectContaining({ purpose: "session-summary", provider: "deepseek" }),
    );
  });
});
