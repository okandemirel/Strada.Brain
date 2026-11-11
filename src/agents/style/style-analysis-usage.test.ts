/**
 * The style analysis bills the campaign's spend (task #71).
 *
 * Measured before the fix: StyleAnalysis.analyze() read only the reply's text,
 * so the call over the whole design document (the largest prompt the pass
 * sends) reached no cost ledger, no daily wall and no /api/metrics counter.
 * These tests drive the REAL StyleAnalysis over a scripted provider and the
 * REAL process ledger, on the streaming and the chat() path. Every game is
 * invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StyleAnalysis } from "./style-analysis.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../../tests/helpers/usage-ledger-harness.js";
import { expectBilledAsCampaignWork, UNMEASURED_WARNING } from "../../tests/helpers/campaign-billing-assertions.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const PURPOSE = "style-analysis";
const PROVIDER = "deepseek";

const PROFILE = JSON.stringify({ family: "realistic", pipeline: "realtime-3d", palette: ["#334455"], shading: "pbr-realistic" });
// A design that names no style keyword, so the keyword fallback cannot stand in for the model's answer.
const GDD = "A quiet game about tending a lighthouse. The art should feel grounded.";

let harness: UsageLedgerHarness;
beforeEach(() => {
  logger.warn.mockClear();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

describe("the style analysis bills the campaign's spend", () => {
  it("a streaming call books its tokens once: counters and one cost row, source chat, trigger style-analysis", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: PROFILE, usage: usage(2400, 120) }], { streaming: true });

    const { source } = await new StyleAnalysis(provider).analyze(GDD);

    expect(source).toBe("llm");
    expect(provider.calls).toHaveLength(1);
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 2400, outputTokens: 120 }] });
  });

  it("with STREAMING_ENABLED=false the chat() path bills the same way", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: PROFILE, usage: usage(2300, 110) }]);

    const { source } = await new StyleAnalysis(provider, { streamingEnabled: false }).analyze(GDD);

    expect(source).toBe("llm");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(provider.calls).toHaveLength(1);
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 2300, outputTokens: 110 }] });
  });

  it("two analyses bill two rows, one per provider call", async () => {
    const replies = [
      { text: PROFILE, usage: usage(2400, 120) },
      { text: PROFILE, usage: usage(2410, 118) },
    ];
    const provider = scriptedProvider(PROVIDER, replies, { streaming: true });
    const analysis = new StyleAnalysis(provider);

    await analysis.analyze(GDD);
    await analysis.analyze(GDD);

    expect(provider.calls).toHaveLength(2);
    expectBilledAsCampaignWork(harness, {
      purpose: PURPOSE,
      provider: PROVIDER,
      calls: replies.map((r) => ({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })),
    });
  });

  it("a reply with no usage books nothing, counts nothing, and says it was not measured", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: PROFILE }]);

    const { source } = await new StyleAnalysis(provider, { streamingEnabled: false }).analyze(GDD);

    expect(source).toBe("llm");
    expect(provider.calls).toHaveLength(1);
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(UNMEASURED_WARNING, expect.objectContaining({ purpose: PURPOSE }));
  });
});
