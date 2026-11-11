/**
 * The choke point every direct provider call bills through (task #71).
 *
 * Driven over the REAL process ledger (createProviderUsageLedger → the hook a
 * model turn bills through: metrics, the rate limiter, the run's onUsage; and
 * the cost ledger for a call no run owns) and, for failover, the REAL
 * FallbackChainProvider. Each case compares what the provider billed with what
 * the counters, the run and the cost ledger received:
 *   - streamed and non-streamed replies count once;
 *   - a caller's retry is two calls and two bills; a chain failover bills the
 *     reply once, plus what the superseded attempt spent (no double count, no
 *     undercount); a call that threw bills what the chain hung on the error;
 *   - no usage, or 0 in and 0 out, is "not measured" and writes no zero;
 *   - with no ledger installed the call still answers, and says it was not billed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billedChat, billedStreamOrChatText, installProviderUsageLedger } from "./billed-call.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { estimateCostWithCache } from "../../common/cost-model.js";
import {
  installUsageLedgerHarness,
  scriptedProvider,
  usage,
  type UsageLedgerHarness,
} from "../../tests/helpers/usage-ledger-harness.js";
import type { ProviderResponse } from "./provider-core.interface.js";
import type { TaskUsageEvent } from "../../tasks/types.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const MSG = [{ role: "user" as const, content: "Sort these seed packets by sowing month." }];
const RUN = (onUsage: (usage: TaskUsageEvent) => void) => ({ purpose: "test-run-call", run: { onUsage } }) as const;
const OWNERLESS = { purpose: "test-background-call", ownerless: "daemon" } as const;

let harness: UsageLedgerHarness;

beforeEach(() => {
  vi.clearAllMocks();
  ProviderHealthRegistry.resetInstance();
  harness = installUsageLedgerHarness();
});

afterEach(() => harness.uninstall());

describe("a call that is part of a run bills the run once (task #71)", () => {
  it("a non-streamed reply reaches the counters and the run's onUsage once, and books no ledger row of its own", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "March, April, May", usage: usage(1200, 300) }]);
    const run = harness.runSink();
    const response = await billedChat(provider, RUN(run.onUsage), "You sort seeds.", MSG, []);

    expect(response.text).toBe("March, April, May");
    expect(provider.chat).toHaveBeenCalledWith("You sort seeds.", MSG, []);
    expect(run.events).toEqual([{ provider: "deepseek", model: undefined, inputTokens: 1200, outputTokens: 300 }]);
    expect(harness.counted()).toEqual({ input: 1200, output: 300, dailyTokens: 1500 });
    // The run's onUsage books the run's ledger row (background executor); a second row would double it.
    expect(harness.booked).toEqual([]);
  });

  it("a streamed reply is billed once, from the streaming path", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "sorted", usage: usage(2100, 350) }], { streaming: true });
    const run = harness.runSink();
    await billedStreamOrChatText(provider, RUN(run.onUsage), "You sort seeds.", "Sort them.");

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(run.events.map((e) => [e.inputTokens, e.outputTokens])).toEqual([[2100, 350]]);
    expect(harness.counted()).toEqual({ input: 2100, output: 350, dailyTokens: 2450 });
  });

  it("streaming switched off goes to chat() and is billed once", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "sorted", usage: usage(800, 90) }]);
    const run = harness.runSink();
    await billedStreamOrChatText(provider, RUN(run.onUsage), "You sort seeds.", "Sort them.", undefined, { streaming: false });

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(run.events.map((e) => e.inputTokens)).toEqual([800]);
    expect(harness.counted().dailyTokens).toBe(890);
  });

  it("an interactive run (no onUsage) still bills the counters", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "ok", usage: usage(500, 50) }]);
    await billedChat(provider, { purpose: "test-run-call", run: {} }, "s", MSG, []);

    expect(harness.counted()).toEqual({ input: 500, output: 50, dailyTokens: 550 });
    expect(harness.booked).toEqual([]);
  });

  it("the model that answered travels with the bill", async () => {
    const provider = {
      ...scriptedProvider("chain", [{ text: "ok", usage: usage(400, 40) }]),
      chat: vi.fn(async () => ({
        text: "ok", toolCalls: [], stopReason: "end_turn", usage: usage(400, 40),
        servedBy: { provider: "deepseek", model: "deepseek-chat" },
      }) as ProviderResponse),
    };
    const run = harness.runSink();
    await billedChat(provider, RUN(run.onUsage), "s", MSG, []);

    expect(run.events).toEqual([{ provider: "deepseek", model: "deepseek-chat", inputTokens: 400, outputTokens: 40 }]);
  });
});

describe("a call no run owns is booked to the cost ledger under its source (task #71)", () => {
  it("books one row, priced like a task's, with the purpose as its trigger, and bills the counters", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "summary", usage: usage(10_000, 2_000) }]);
    await billedChat(provider, OWNERLESS, "s", MSG, []);

    expect(harness.booked).toEqual([
      {
        amount: estimateCostWithCache({ inputTokens: 10_000, outputTokens: 2_000 }, "deepseek"),
        source: "daemon",
        metadata: { model: "deepseek", tokensIn: 10_000, tokensOut: 2_000, triggerName: "test-background-call" },
      },
    ]);
    expect(harness.booked[0]!.amount).toBeGreaterThan(0);
    expect(harness.counted()).toEqual({ input: 10_000, output: 2_000, dailyTokens: 12_000 });
  });

  it("a free model books no dollars but its tokens still count against the daily token quota", async () => {
    const provider = {
      ...scriptedProvider("opencode", []),
      chat: vi.fn(async () => ({
        text: "ok", toolCalls: [], stopReason: "end_turn", usage: usage(3_000, 300),
        servedBy: { provider: "opencode", model: "big-pickle-free" },
      }) as ProviderResponse),
    };
    await billedChat(provider, OWNERLESS, "s", MSG, []);

    expect(harness.booked).toEqual([]);
    expect(harness.counted().dailyTokens).toBe(3_300);
  });
});

describe("retries and failover count each spend exactly once (task #71)", () => {
  it("a caller that retries makes two calls and is billed twice — each reply once", async () => {
    const provider = scriptedProvider("deepseek", [
      { text: "not json", usage: usage(1000, 100) },
      { text: "{}", usage: usage(1100, 120) },
    ]);
    const run = harness.runSink();
    await billedChat(provider, RUN(run.onUsage), "s", MSG, []);
    await billedChat(provider, RUN(run.onUsage), "s", MSG, []);

    expect(run.events.map((e) => e.inputTokens)).toEqual([1000, 1100]);
    expect(harness.counted()).toEqual({ input: 2100, output: 220, dailyTokens: 2320 });
  });

  it("a failover to the chain's second member bills that member once, and the member that refused nothing", async () => {
    const first = scriptedProvider("primary", [new Error("Invalid request: model is not supported on this plan")]);
    const second = scriptedProvider("backup", [{ text: "ok", usage: usage(1700, 450) }]);
    const chain = new FallbackChainProvider([first, second], { attemptTimeoutMs: 5_000 });
    const run = harness.runSink();
    await billedChat(chain, RUN(run.onUsage), "s", MSG, []);

    expect(second.chat).toHaveBeenCalledTimes(1);
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({ provider: "backup", inputTokens: 1700, outputTokens: 450 });
    expect(harness.counted().dailyTokens).toBe(2150);
  });

  it("an empty answer the chain fell over from is billed beside the reply that replaced it", async () => {
    const empty = scriptedProvider("primary", [{ text: "", usage: usage(1600, 20) }]);
    const backup = scriptedProvider("backup", [{ text: "ok", usage: usage(1700, 450) }]);
    const chain = new FallbackChainProvider([empty, backup], { attemptTimeoutMs: 5_000 });
    const run = harness.runSink();
    await billedChat(chain, RUN(run.onUsage), "s", MSG, []);

    expect(run.events).toHaveLength(2);
    expect(harness.counted()).toEqual({ input: 1600 + 1700, output: 20 + 450, dailyTokens: 3770 });
  });

  it("a call that threw after spending bills what was hung on the error, once, and rethrows it", async () => {
    const spent = Object.assign(new Error("upstream 503 Service Unavailable"), { usage: usage(1400, 30) });
    const provider = scriptedProvider("deepseek", [spent]);
    const run = harness.runSink();

    await expect(billedChat(provider, RUN(run.onUsage), "s", MSG, [])).rejects.toBe(spent);
    expect(run.events.map((e) => [e.inputTokens, e.outputTokens])).toEqual([[1400, 30]]);
    expect(harness.counted().dailyTokens).toBe(1430);
  });

  it("a call that threw with nothing recorded is logged as not measured, bills nothing, and rethrows", async () => {
    const failure = new Error("connect ECONNREFUSED");
    const provider = scriptedProvider("deepseek", [failure]);
    const run = harness.runSink();

    await expect(billedChat(provider, RUN(run.onUsage), "s", MSG, [])).rejects.toBe(failure);
    expect(run.events).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call usage not measured — the call threw before a reply",
      { purpose: "test-run-call", provider: "deepseek" },
    );
  });
});

describe("an unmeasured reply writes no zero (task #71)", () => {
  it("a reply with no usage field is logged as not measured and bills nothing", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "ok" }]);
    const run = harness.runSink();
    await billedChat(provider, RUN(run.onUsage), "s", MSG, []);

    expect(run.events).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call usage not measured — nothing billed for this call",
      { purpose: "test-run-call", provider: "deepseek", reason: "the provider returned no usage field" },
    );
  });

  it("a reply reading 0 in and 0 out is not measured either, and books no ledger row", async () => {
    const provider = scriptedProvider("deepseek", [{ text: "ok", usage: usage(0, 0) }]);
    await billedChat(provider, OWNERLESS, "s", MSG, []);

    expect(harness.booked).toEqual([]);
    expect(harness.counted().dailyTokens).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call usage not measured — nothing billed for this call",
      { purpose: "test-background-call", provider: "deepseek", reason: "the provider reported 0 input and 0 output tokens" },
    );
  });
});

describe("with no ledger installed (task #71)", () => {
  it("the call still answers, and says its usage was not billed", async () => {
    harness.uninstall();
    const provider = scriptedProvider("deepseek", [{ text: "ok", usage: usage(700, 70) }]);
    const response = await billedChat(provider, OWNERLESS, "s", MSG, []);

    expect(response.text).toBe("ok");
    expect(harness.counted().dailyTokens).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call not billed — no usage ledger is installed",
      expect.objectContaining({ purpose: "test-background-call", provider: "deepseek", usage: usage(700, 70) }),
    );
  });

  afterEach(() => installProviderUsageLedger(undefined));
});
