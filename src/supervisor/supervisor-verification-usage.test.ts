/**
 * The node verifier's review call bills the run that asked for it (task #71).
 *
 * Measured before the fix: the REAL createSupervisorNodeVerifier called
 * streamOrChatText and read only the text, so a review that billed N tokens
 * reached no run's usage record, no rate limiter and no /api/metrics counter.
 * Drives the REAL verifier through the REAL process ledger; only the provider
 * is scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupervisorNodeVerifier } from "./supervisor-verification.js";
import type { NodeResult, SupervisorContext } from "./supervisor-types.js";
import { ProviderHealthRegistry } from "../agents/providers/provider-health.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const APPROVE = '{"verdict":"approve"}';

function workerNode(): NodeResult {
  return {
    nodeId: "node-1" as never,
    status: "ok",
    output: "Implemented the endpoint.",
    artifacts: [{ path: "src/api/auth.ts", action: "modify" }],
    toolResults: [],
    provider: "claude",
    model: "sonnet",
    cost: 0.1,
    duration: 100,
  };
}

function verifierFor(reviewer: ReturnType<typeof scriptedProvider>, options?: { streamingEnabled?: boolean }) {
  return createSupervisorNodeVerifier(
    {
      listExecutionCandidates: () => [
        { name: "Claude", defaultModel: "sonnet" },
        { name: "Kimi (Moonshot)", defaultModel: "kimi-for-coding" },
      ],
      listAvailable: () => [{ name: "Kimi (Moonshot)", defaultModel: "kimi-for-coding" }],
      getProviderByName: (name: string) => (name === "kimi" ? reviewer : null),
    },
    options,
  );
}

let harness: UsageLedgerHarness;

beforeEach(() => {
  vi.clearAllMocks();
  ProviderHealthRegistry.resetInstance();
  harness = installUsageLedgerHarness();
});

afterEach(() => harness.uninstall());

describe("the supervisor node verifier bills its review call to the run (task #71)", () => {
  it("a streamed review reaches the run's onUsage once and the counters once, and books no ledger row of its own", async () => {
    const reviewer = scriptedProvider("kimi", [{ text: APPROVE, usage: usage(1200, 300) }], { streaming: true });
    const run = harness.runSink();

    const verdict = await verifierFor(reviewer)(workerNode(), { chatId: "chat-1", onUsage: run.onUsage } as SupervisorContext);

    expect(verdict.verdict).toBe("approve");
    expect(reviewer.chatStream).toHaveBeenCalledTimes(1);
    expect(run.events).toEqual([expect.objectContaining({ provider: "kimi", inputTokens: 1200, outputTokens: 300 })]);
    expect(run.events).toHaveLength(1);
    expect(harness.counted()).toEqual({ input: 1200, output: 300, dailyTokens: 1500 });
    expect(harness.booked).toEqual([]);
  });

  it("a non-streamed review (STREAMING_ENABLED=false) bills the same way", async () => {
    const reviewer = scriptedProvider("kimi", [{ text: APPROVE, usage: usage(1200, 300) }]);
    const run = harness.runSink();

    const verdict = await verifierFor(reviewer, { streamingEnabled: false })(workerNode(), { chatId: "chat-1", onUsage: run.onUsage } as SupervisorContext);

    expect(verdict.verdict).toBe("approve");
    expect(reviewer.chat).toHaveBeenCalledTimes(1);
    expect(run.events).toEqual([expect.objectContaining({ provider: "kimi", inputTokens: 1200, outputTokens: 300 })]);
    expect(run.events).toHaveLength(1);
    expect(harness.counted()).toEqual({ input: 1200, output: 300, dailyTokens: 1500 });
    expect(harness.booked).toEqual([]);
  });

  it("a review that came back with no usage bills nothing and says it was not measured", async () => {
    const reviewer = scriptedProvider("kimi", [{ text: APPROVE }], { streaming: true });
    const run = harness.runSink();

    const verdict = await verifierFor(reviewer)(workerNode(), { chatId: "chat-1", onUsage: run.onUsage } as SupervisorContext);

    expect(verdict.verdict).toBe("approve");
    expect(run.events).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider call usage not measured — nothing billed for this call",
      expect.objectContaining({ purpose: "supervisor-verification", provider: "kimi" }),
    );
  });

  it("a reviewer that throws having spent tokens is skipped, and what it spent is billed once", async () => {
    const reviewer = scriptedProvider(
      "kimi",
      [Object.assign(new Error("the reviewer fell over mid-reply"), { usage: usage(900, 10) })],
      { streaming: true },
    );
    const run = harness.runSink();

    const verdict = await verifierFor(reviewer)(workerNode(), { chatId: "chat-1", onUsage: run.onUsage } as SupervisorContext);

    expect(verdict.verdict).toBe("skipped");
    expect(run.events).toEqual([expect.objectContaining({ provider: "kimi", inputTokens: 900, outputTokens: 10 })]);
    expect(run.events).toHaveLength(1);
    expect(harness.counted()).toEqual({ input: 900, output: 10, dailyTokens: 910 });
  });
});
