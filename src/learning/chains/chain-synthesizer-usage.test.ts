/**
 * A chain-synthesis call's tokens reach the spend counters and the cost ledger (task #71).
 *
 * ChainSynthesizer called provider.chat and kept only the JSON text: background
 * learning spent tokens that no counter and no cost row ever saw. These tests
 * drive the REAL ChainSynthesizer over the REAL process ledger
 * (usage-ledger-harness) and compare what the provider billed with what was
 * recorded.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ChainSynthesizer } from "./chain-synthesizer.js";
import type { CandidateChain, ToolChainConfig } from "./chain-types.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { IEventBus, LearningEventMap } from "../../core/event-bus.js";
import { estimateCostWithCache } from "../../common/cost-model.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const CONFIG: ToolChainConfig = {
  enabled: true,
  minOccurrences: 3,
  successRateThreshold: 0.8,
  maxActive: 10,
  maxAgeDays: 30,
  llmBudgetPerCycle: 5,
  minChainLength: 2,
  maxChainLength: 5,
  detectionIntervalMs: 60000,
  resilience: { rollbackEnabled: true, parallelEnabled: true, maxParallelBranches: 4, compensationTimeoutMs: 30000 },
};

const CANDIDATE: CandidateChain = {
  toolNames: ["fetch_weather", "format_report"],
  occurrences: 5,
  successCount: 5,
  sampleSteps: [],
  key: "fetch_weather,format_report",
};

const REPLY_TEXT = JSON.stringify({
  name: "weather_report",
  description: "Fetches the weather and formats it as a short report",
  parameterMappings: [],
  inputSchema: { type: "object" },
});

function synthesizerWith(provider: ReturnType<typeof scriptedProvider>): ChainSynthesizer {
  const storage = { getInstincts: vi.fn().mockReturnValue([]), createInstinct: vi.fn() } as unknown as LearningStorage;
  const registry = {
    has: vi.fn(() => true),
    getMetadata: vi.fn(() => undefined),
    registerOrUpdate: vi.fn(),
  } as unknown as ToolRegistry;
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), shutdown: vi.fn() } as unknown as IEventBus<LearningEventMap>;
  const synthesizer = new ChainSynthesizer(storage, registry, eventBus, CONFIG);
  synthesizer.setProvider(provider);
  return synthesizer;
}

let harness: UsageLedgerHarness;
beforeEach(() => {
  vi.clearAllMocks();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

describe("ChainSynthesizer bills the synthesis call (task #71)", () => {
  it("a synthesis reply with usage reaches the counters and books one ledger row under daemon", async () => {
    const provider = scriptedProvider("deepseek", [{ text: REPLY_TEXT, usage: usage(1900, 310) }]);
    const tools = await synthesizerWith(provider).synthesize([CANDIDATE]);

    expect(tools).toHaveLength(1); // the call ran and parsed: this is the real path
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(harness.counted()).toEqual({ input: 1900, output: 310, dailyTokens: 2210 });
    expect(harness.booked).toHaveLength(1);
    const row = harness.booked[0]!;
    expect(row.source).toBe("daemon");
    expect(row.metadata).toMatchObject({ triggerName: "chain-synthesis", tokensIn: 1900, tokensOut: 310 });
    expect(row.amount).toBeGreaterThan(0);
    expect(row.amount).toBe(estimateCostWithCache({ inputTokens: 1900, outputTokens: 310 }, "deepseek"));
  });
});
