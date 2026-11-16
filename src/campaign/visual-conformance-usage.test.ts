/**
 * The vision check of a delivered frame bills the campaign's spend (task #71).
 *
 * Measured before the fix: judgeVisualConformance called the vision provider's
 * chat() and read only the text, so an image-bearing call (the most expensive
 * kind of call the campaign makes) reached no cost ledger, no daily wall and
 * no /api/metrics counter. These tests drive the REAL judgement over a
 * scripted vision provider and the REAL process ledger, with a real frame on
 * disk. Every game is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeVisualConformance } from "./visual-conformance.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";
import { expectBilledAsCampaignWork, UNMEASURED_WARNING } from "../tests/helpers/campaign-billing-assertions.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const PURPOSE = "visual-conformance";
const PROVIDER = "deepseek";
const LOOK = { found: true, text: "paper-cut lanterns in warm amber over a night sky of deep indigo, a small moth with soft wings" };

/** The eight bytes every PNG starts with, then filler: enough for the frame reader and the media-type sniffing. */
const TINY_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let harness: UsageLedgerHarness;
let root: string;
let framePath: string;
beforeEach(() => {
  logger.warn.mockClear();
  harness = installUsageLedgerHarness();
  root = mkdtempSync(join(tmpdir(), "vc-usage-"));
  framePath = join(root, "frame.png");
  writeFileSync(framePath, TINY_PNG);
});
afterEach(() => {
  harness.uninstall();
  rmSync(root, { recursive: true, force: true });
});

describe("the visual conformance check bills the campaign's spend", () => {
  it("one vision call books its tokens once: counters and one cost row, source chat, trigger visual-conformance", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "Amber lanterns over an indigo sky.\nMATCH: yes", usage: usage(1700, 45) }]);

    const result = await judgeVisualConformance({ look: LOOK, frame: { path: framePath }, visionProvider: { provider, name: PROVIDER } });

    expect(result.status).toBe("checked");
    expect(result.matches).toBe(true);
    expect(provider.calls).toHaveLength(1);
    // The frame really went out with the call that was billed.
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain('"media_type":"image/png"');
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 1700, outputTokens: 45 }] });
  });

  it("two checks bill two rows, one per provider call, each at its own reply's cost", async () => {
    const replies = [
      { text: "Amber lanterns.\nMATCH: yes", usage: usage(1700, 45) },
      { text: "An empty sky.\nMATCH: no", usage: usage(1650, 38) },
    ];
    const provider = scriptedProvider(PROVIDER, replies);

    const first = await judgeVisualConformance({ look: LOOK, frame: { path: framePath }, visionProvider: { provider, name: PROVIDER } });
    const second = await judgeVisualConformance({ look: LOOK, frame: { path: framePath }, visionProvider: { provider, name: PROVIDER } });

    expect([first.matches, second.matches]).toEqual([true, false]);
    expect(provider.calls).toHaveLength(2);
    expectBilledAsCampaignWork(harness, {
      purpose: PURPOSE,
      provider: PROVIDER,
      calls: replies.map((r) => ({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })),
    });
  });

  it("a check that never reaches the provider (no frame) bills nothing", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "unused", usage: usage(1, 1) }]);

    const result = await judgeVisualConformance({ look: LOOK, frame: {}, visionProvider: { provider, name: PROVIDER } });

    expect(result.status).toBe("not-checked");
    expect(provider.calls).toHaveLength(0);
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
  });

  it("a reply with no usage books nothing, counts nothing, and says it was not measured", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "Amber lanterns.\nMATCH: yes" }]);

    const result = await judgeVisualConformance({ look: LOOK, frame: { path: framePath }, visionProvider: { provider, name: PROVIDER } });

    expect(result.status).toBe("checked");
    expect(provider.calls).toHaveLength(1);
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(UNMEASURED_WARNING, expect.objectContaining({ purpose: PURPOSE }));
  });
});
