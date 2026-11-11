/**
 * Boot installs the ledger every direct provider call bills through (task #71).
 *
 * The choke point (billed-call.ts) bills nothing until a ledger is installed,
 * and only bootstrap has the counters to build one. These tests run the REAL
 * wiring function over a real MetricsCollector and RateLimiter and a recording
 * cost ledger, then make a billed call and read where its tokens landed —
 * with the rate limiter on, and off (RATE_LIMIT_ENABLED defaults to false).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as winston from "winston";
import { wireSpendCounters } from "./bootstrap-spend-counters.js";
import { billedChat, installProviderUsageLedger } from "../agents/providers/billed-call.js";
import { RateLimiter } from "../security/rate-limiter.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { scriptedProvider, usage, type BookedCost } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

function wire(rateLimiter: RateLimiter | undefined) {
  const metrics = new MetricsCollector();
  const booked: BookedCost[] = [];
  const dashboard = { setRateLimiter: vi.fn() };
  wireSpendCounters({
    rateLimiter,
    metrics,
    overrides: { getSettingsOverride: () => undefined },
    ledger: { recordedSpendSince: () => 0, recordCost: (amount, source, metadata) => booked.push({ amount, source, metadata }) },
    dashboard,
    logger: logger as unknown as winston.Logger,
  });
  return { metrics, booked, dashboard };
}

const MSG = [{ role: "user" as const, content: "Summarize the greenhouse log." }];

afterEach(() => installProviderUsageLedger(undefined));

describe("wireSpendCounters installs the provider usage ledger (task #71)", () => {
  it("a background call then reaches /api/metrics, the rate limiter's daily total and the cost ledger", async () => {
    const rateLimiter = new RateLimiter({});
    const { metrics, booked, dashboard } = wire(rateLimiter);
    await billedChat(scriptedProvider("deepseek", [{ text: "ok", usage: usage(6_000, 500) }]), { purpose: "session-summary", ownerless: "daemon" }, "s", MSG, []);

    expect(metrics.getSnapshot().totalTokens).toEqual({ input: 6_000, output: 500 });
    expect(rateLimiter.getSnapshot().tokensToday).toBe(6_500);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ source: "daemon", metadata: { triggerName: "session-summary", tokensIn: 6_000, tokensOut: 500 } });
    // The block it was moved with still runs: the live limiter is handed to the dashboard.
    expect(dashboard.setRateLimiter).toHaveBeenCalledWith(rateLimiter);
  });

  it("with the rate limiter off (the default), metrics and the cost ledger still see the call", async () => {
    const { metrics, booked, dashboard } = wire(undefined);
    await billedChat(scriptedProvider("deepseek", [{ text: "ok", usage: usage(1_000, 100) }]), { purpose: "chain-synthesis", ownerless: "daemon" }, "s", MSG, []);

    expect(metrics.getSnapshot().totalTokens).toEqual({ input: 1_000, output: 100 });
    expect(booked).toHaveLength(1);
    expect(dashboard.setRateLimiter).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith("Provider call not billed — no usage ledger is installed", expect.anything());
  });
});
