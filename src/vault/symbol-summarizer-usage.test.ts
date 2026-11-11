/**
 * A dashboard "summarize this symbol" call's tokens reach the counters and the cost ledger (task #71).
 *
 * summarizeSymbol called provider.chat and kept only the sentence: a user's
 * click on the vault page spent tokens that no counter and no cost row ever
 * saw. These tests drive the REAL summarizeSymbol over the REAL process ledger
 * (usage-ledger-harness).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { summarizeSymbol, type SymbolInfo } from "./symbol-summarizer.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { estimateCostWithCache } from "../common/cost-model.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const SYMBOL: SymbolInfo = { name: "TideTable", kind: "class", path: "src/harbor/tide-table.ts", startLine: 1, endLine: 3 };
const readFile = async (): Promise<string> => "class TideTable {\n  next(): number { return 4; }\n}";

let harness: UsageLedgerHarness;
beforeEach(() => {
  vi.clearAllMocks();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

describe("summarizeSymbol bills the summary call (task #71)", () => {
  it("a reply with usage reaches the counters and books one ledger row under chat (a user asked)", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "Predicts the next high tide.", usage: usage(640, 40) }]);
    const result = await summarizeSymbol({ provider }, SYMBOL, readFile);

    expect(result).toBe("Predicts the next high tide.");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(harness.counted()).toEqual({ input: 640, output: 40, dailyTokens: 680 });
    expect(harness.booked).toHaveLength(1);
    const row = harness.booked[0]!;
    expect(row.source).toBe("chat");
    expect(row.metadata).toMatchObject({ triggerName: "vault-symbol-summary", tokensIn: 640, tokensOut: 40 });
    expect(row.amount).toBeGreaterThan(0);
    expect(row.amount).toBe(estimateCostWithCache({ inputTokens: 640, outputTokens: 40 }, "deepseek"));
  });

  it("a reply from a free model is counted but books no cost row", async () => {
    // The harness's scriptedProvider cannot say who served the call: build the chain-style reply inline.
    const provider = {
      name: "opencode",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async () => ({
        text: "Predicts the next high tide.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: usage(640, 40),
        servedBy: { provider: "opencode", model: "glm-5.3-free" },
      })),
    } as unknown as IAIProvider;
    const result = await summarizeSymbol({ provider }, SYMBOL, readFile);

    expect(result).toBe("Predicts the next high tide.");
    expect(harness.counted()).toEqual({ input: 640, output: 40, dailyTokens: 680 });
    expect(harness.booked).toEqual([]);
  });

  it("a reply without usage books nothing, counts nothing, and says so", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "Predicts the next high tide." }]);
    const result = await summarizeSymbol({ provider }, SYMBOL, readFile);

    expect(result).toBe("Predicts the next high tide.");
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call usage not measured — nothing billed for this call",
      expect.objectContaining({ purpose: "vault-symbol-summary", provider: "deepseek" }),
    );
  });
});
