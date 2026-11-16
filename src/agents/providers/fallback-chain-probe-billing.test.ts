/**
 * The fallback chain's recovery health probe is billed (task #72).
 *
 * A member that leaves its cooldown is probed ("Reply with OK") before it gets
 * real traffic. The probe is a real provider call — a handful of tokens — and
 * no run owns it, so it bills as daemon spend through billedChat: /api/metrics,
 * the rate limiter's daily wall and the cost ledger, once each. The chain's
 * real reply is not billed here: its consumer bills it (servedBy).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

let ledger: UsageLedgerHarness;

beforeEach(() => {
  ProviderHealthRegistry.resetInstance();
  ledger = installUsageLedgerHarness();
});

afterEach(() => {
  ledger.uninstall();
  ProviderHealthRegistry.resetInstance();
});

/** Put `name` into the recovering state: benched, cooldown already expired. */
function recovering(name: string): void {
  const health = ProviderHealthRegistry.getInstance();
  for (let i = 0; i < 5; i++) health.recordFailure(name, "timeout");
  Object.assign(health.getEntry(name)!, { cooldownUntil: Date.now() - 1000 });
  expect(health.isRecovering(name)).toBe(true);
}

describe("FallbackChainProvider — the recovery probe bills as daemon spend (task #72)", () => {
  it("the probe's tokens reach metrics, the rate limiter and the cost ledger once; the real reply is left to its consumer", async () => {
    const member = scriptedProvider("deepseek", [
      { text: "OK", usage: usage(12, 2) },
      { text: "the real answer", usage: usage(4_000, 300) },
    ]);
    recovering("deepseek");

    const reply = await new FallbackChainProvider([member]).chat("sys", [{ role: "user", content: "hi" }], []);

    expect(member.calls[0]!.system).toBe("Reply with OK");
    expect(reply.text).toBe("the real answer");
    expect(ledger.counted()).toEqual({ input: 12, output: 2, dailyTokens: 14 });
    expect(ledger.booked).toHaveLength(1);
    expect(ledger.booked[0]).toMatchObject({
      source: "daemon",
      metadata: { tokensIn: 12, tokensOut: 2, triggerName: "provider-health-probe" },
    });
  });

  it("a probe that throws after spending bills what it spent", async () => {
    const spent = Object.assign(new Error("upstream 500"), { usage: usage(9, 0) });
    const member = scriptedProvider("deepseek", [spent]);
    const fallback = scriptedProvider("kimi", [{ text: "from the fallback", usage: usage(50, 5) }]);
    recovering("deepseek");

    const reply = await new FallbackChainProvider([member, fallback]).chat("sys", [{ role: "user", content: "hi" }], []);

    expect(reply.text).toBe("from the fallback");
    expect(ledger.counted()).toEqual({ input: 9, output: 0, dailyTokens: 9 });
  });
});
