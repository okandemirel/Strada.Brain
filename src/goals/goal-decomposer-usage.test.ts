/**
 * Every goal-decomposition reply bills the run that asked for the plan — once.
 *
 * Measured before the fix (task #67): GoalDecomposer never read the reply's
 * usage, so a plan call billed N tokens and the run's usage record took 0 of
 * them — on the root run and on a delegated run alike. These tests drive the
 * REAL GoalDecomposer (and, for failover, the REAL FallbackChainProvider) and
 * compare what the provider billed with what reached the sink:
 *   - streaming and non-streaming replies each count once;
 *   - a retried round and a chain failover count the reply that came back
 *     once (no double count), plus what a superseded or failed attempt had
 *     already spent, as the chain records it (no undercount);
 *   - a refused-then-retried plan and a depth-2 expansion count every reply
 *     (no undercount);
 *   - a reply with no usage is logged "not measured" and writes no zero.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalDecomposer } from "./goal-decomposer.js";
import type { DecompositionUsage } from "./decomposition-usage.js";
import type { GoalNodeId, GoalTree } from "./types.js";
import type { IAIProvider, IStreamingProvider } from "../agents/providers/provider.interface.js";
import type { ProviderResponse, TokenUsage } from "../agents/providers/provider-core.interface.js";
import { FallbackChainProvider } from "../agents/providers/fallback-chain.js";
import { ProviderHealthRegistry } from "../agents/providers/provider-health.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

/** A plan with no needsFurtherDecomposition flag: exactly one call when it parses. */
const FLAT_PLAN = JSON.stringify({
  nodes: [
    { id: "a", task: "Write the parser for the recipe file format", dependsOn: [] },
    { id: "b", task: "Add a test that loads three sample recipe files", dependsOn: ["a"] },
  ],
});

/** A plan whose first node asks for a depth-2 expansion: two calls. */
const FLAGGED_PLAN = JSON.stringify({
  nodes: [
    { id: "a", task: "Build the recipe importer end to end", dependsOn: [], needsFurtherDecomposition: true },
    { id: "b", task: "Write the importer's user guide page", dependsOn: ["a"] },
  ],
});

const usage = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

type Reply = { text: string; usage?: TokenUsage } | Error;

function reply(r: Exclude<Reply, Error>): ProviderResponse {
  return { text: r.text, toolCalls: [], stopReason: "end_turn", usage: r.usage } as ProviderResponse;
}

function chatProvider(name: string, replies: Reply[]): IAIProvider & { chat: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    name,
    capabilities: { maxTokens: 8192, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
    chat: vi.fn(async () => {
      const r = replies[Math.min(i++, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      return reply(r);
    }),
    isAvailable: () => Promise.resolve(true),
  } as unknown as IAIProvider & { chat: ReturnType<typeof vi.fn> };
}

function streamProvider(name: string, replies: Reply[]): IStreamingProvider & { chatStream: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    name,
    capabilities: { maxTokens: 8192, streaming: true, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
    chat: vi.fn(async () => {
      throw new Error("chat() must not run when the provider streams");
    }),
    chatStream: vi.fn(async (_s: string, _m: unknown, _t: unknown, onChunk: (c: string) => void) => {
      const r = replies[Math.min(i++, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      onChunk(r.text);
      return reply(r);
    }),
    isAvailable: () => Promise.resolve(true),
  } as unknown as IStreamingProvider & { chatStream: ReturnType<typeof vi.fn> };
}

function sink(): { onUsage: (u: DecompositionUsage) => void; records: DecompositionUsage[] } {
  const records: DecompositionUsage[] = [];
  return { onUsage: (u) => records.push(u), records };
}

const TASK = "Import recipes from three file formats, validate them, and show the import report";
const totalIn = (rs: DecompositionUsage[]) => rs.reduce((n, r) => n + r.usage.inputTokens, 0);
const totalOut = (rs: DecompositionUsage[]) => rs.reduce((n, r) => n + r.usage.outputTokens, 0);

beforeEach(() => {
  vi.clearAllMocks();
  ProviderHealthRegistry.resetInstance();
});

describe("GoalDecomposer bills every served reply to the caller's sink (task #67)", () => {
  it("a non-streamed plan call reaches the sink once, with the tokens the provider billed", async () => {
    const provider = chatProvider("planner", [{ text: FLAT_PLAN, usage: usage(1800, 600) }]);
    const s = sink();
    const tree = await new GoalDecomposer(provider, 1).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(tree.nodes.size).toBe(3); // root + 2: the plan parsed, so this was the one and only call
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(s.records).toEqual([{ provider: "planner", usage: usage(1800, 600) }]);
  });

  it("a streamed plan call reaches the sink once, with the tokens the provider billed", async () => {
    const provider = streamProvider("planner-stream", [{ text: FLAT_PLAN, usage: usage(2100, 350) }]);
    const s = sink();
    await new GoalDecomposer(provider, 1).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(s.records).toEqual([{ provider: "planner-stream", usage: usage(2100, 350) }]);
  });

  it("a round that threw and a round that answered count once: the reply, not the attempt", async () => {
    const provider = chatProvider("planner", [
      new Error("upstream 503 Service Unavailable"),
      { text: FLAT_PLAN, usage: usage(1500, 400) },
    ]);
    const s = sink();
    await new GoalDecomposer(provider, 1, [0, 0]).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(s.records).toEqual([{ provider: "planner", usage: usage(1500, 400) }]);
    // The attempt that threw is named as unmeasured, not silently dropped.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Goal decomposition attempt 1/2 failed"),
      expect.objectContaining({ usage: expect.stringContaining("not measured") }),
    );
  });

  it("a failover to the chain's second member bills that member once, and the failed one not at all", async () => {
    const first = chatProvider("primary", [new Error("Invalid request: model is not supported on this plan")]);
    const second = chatProvider("backup", [{ text: FLAT_PLAN, usage: usage(1700, 450) }]);
    const chain = new FallbackChainProvider([first, second], { attemptTimeoutMs: 5_000 });
    const s = sink();
    await new GoalDecomposer(chain, 1, [0]).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(second.chat).toHaveBeenCalledTimes(1);
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ provider: "backup", usage: usage(1700, 450) });
  });

  it("an empty answer the chain fell over from is billed beside the reply that replaced it", async () => {
    // The chain carries the superseded attempt's tokens on the answer (auxiliaryUsage); the
    // worker's model turns bill them, and a plan call that dropped them would undercount.
    const empty = chatProvider("primary", [{ text: "", usage: usage(1600, 20) }]);
    const backup = chatProvider("backup", [{ text: FLAT_PLAN, usage: usage(1700, 450) }]);
    const chain = new FallbackChainProvider([empty, backup], { attemptTimeoutMs: 5_000 });
    const s = sink();
    await new GoalDecomposer(chain, 1, [0]).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(empty.chat).toHaveBeenCalledTimes(1);
    expect(backup.chat).toHaveBeenCalledTimes(1);
    expect(totalIn(s.records)).toBe(1600 + 1700);
    expect(totalOut(s.records)).toBe(20 + 450);
    expect(s.records).toHaveLength(2);
  });

  it("a call that threw after spending tokens bills what the chain hung on the error, once", async () => {
    const spent = Object.assign(new Error("upstream 503 Service Unavailable"), { usage: usage(1400, 30) });
    const provider = chatProvider("planner", [spent, { text: FLAT_PLAN, usage: usage(1500, 400) }]);
    const s = sink();
    await new GoalDecomposer(provider, 1, [0, 0]).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(s.records).toEqual([
      { provider: "planner", usage: usage(1400, 30) },
      { provider: "planner", usage: usage(1500, 400) },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Goal decomposition attempt 1/2 failed"),
      expect.objectContaining({ usage: "billed from the chain's record of the lost attempts" }),
    );
  });

  it("a refused plan and its retry are two replies, and both are billed", async () => {
    const provider = chatProvider("planner", [
      { text: "I could not decide on a plan.", usage: usage(1200, 900) },
      { text: FLAT_PLAN, usage: usage(1300, 500) },
    ]);
    const s = sink();
    await new GoalDecomposer(provider, 1).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(totalIn(s.records)).toBe(2500);
    expect(totalOut(s.records)).toBe(1400);
    expect(s.records).toHaveLength(2);
  });

  it("a depth-2 expansion is its own call, and is billed beside the root plan", async () => {
    const provider = chatProvider("planner", [
      { text: FLAGGED_PLAN, usage: usage(1800, 600) },
      { text: FLAT_PLAN, usage: usage(900, 300) },
    ]);
    const s = sink();
    await new GoalDecomposer(provider, 3).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(s.records.map((r) => r.usage.inputTokens)).toEqual([1800, 900]);
  });

  it("a reactive re-plan is billed too", async () => {
    const provider = chatProvider("planner", [{ text: FLAT_PLAN, usage: usage(1100, 250) }]);
    const tree: GoalTree = {
      rootId: "root" as GoalNodeId,
      sessionId: "s1",
      taskDescription: TASK,
      createdAt: 0,
      nodes: new Map([
        ["root" as GoalNodeId, { id: "root" as GoalNodeId, parentId: null, task: TASK, dependsOn: [], depth: 0, status: "executing", createdAt: 0, updatedAt: 0 }],
        ["n1" as GoalNodeId, { id: "n1" as GoalNodeId, parentId: "root" as GoalNodeId, task: "Parse the files", dependsOn: [], depth: 1, status: "executing", createdAt: 0, updatedAt: 0 }],
      ]),
    };
    const s = sink();
    const updated = await new GoalDecomposer(provider, 3).decomposeReactive(tree, "n1" as GoalNodeId, "the parser threw", { onUsage: s.onUsage });

    expect(updated).not.toBeNull();
    expect(s.records).toEqual([{ provider: "planner", usage: usage(1100, 250) }]);
  });

  it("a reply with no usage field is logged as not measured and writes no zero", async () => {
    const provider = chatProvider("silent", [{ text: FLAT_PLAN }]);
    const s = sink();
    await new GoalDecomposer(provider, 1).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(s.records).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Goal decomposition usage not measured — nothing billed for this call",
      { provider: "silent", reason: "the provider returned no usage field" },
    );
  });

  it("a reply whose usage reads 0 in and 0 out is not measured either (the parsers' default for a missing field)", async () => {
    const provider = chatProvider("zeroes", [{ text: FLAT_PLAN, usage: usage(0, 0) }]);
    const s = sink();
    await new GoalDecomposer(provider, 1).decomposeProactive("s1", TASK, { onUsage: s.onUsage });

    expect(s.records).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Goal decomposition usage not measured — nothing billed for this call",
      { provider: "zeroes", reason: "the provider reported 0 input and 0 output tokens" },
    );
  });
});
