/**
 * Every acceptance-writer call bills the campaign's spend (task #71).
 *
 * Measured before the fix: AcceptanceAuthor.run() read the reply's text and
 * the model that served it, never its usage, so a writer batch consumed tokens
 * that reached no cost ledger, no daily wall and no /api/metrics counter.
 * These tests drive the REAL AcceptanceAuthor over a scripted provider and the
 * REAL process ledger. Every game is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptanceAuthor, WRITER_BATCH_ROWS, type WriterProviderSource } from "./acceptance-author.js";
import { harnessApiDoc } from "./acceptance-files.js";
import type { AcceptanceCheckBody, AcceptanceWriteContext, RequirementRow } from "./scope-types.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type ScriptedProvider, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";
import { expectBilledAsCampaignWork, UNMEASURED_WARNING } from "../tests/helpers/campaign-billing-assertions.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const PURPOSE = "acceptance-author";
const PROVIDER = "deepseek";
const NUNIT = "global::NUnit.Framework";
const SURFACE = "public interface global::Glow.ILives\n  int Count { get; }";

let harness: UsageLedgerHarness;
beforeEach(() => {
  logger.warn.mockClear();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

const rows = (n: number): RequirementRow[] =>
  Array.from({ length: n }, (_, i) => ({
    rid: `req-${String(i + 1).padStart(3, "0")}-${(i + 1).toString(16).padStart(12, "0")}`,
    encoded: `Lantern ${i + 1} lights when the moth lands on it.`,
    text: `Lantern ${i + 1} lights when the moth lands on it.`,
    section: "Lanterns",
    sectionNumber: "2.4",
    line: 100 + i,
    span: { start: 1000 + i * 60, end: 1050 + i * 60 },
    kind: "rule" as const,
    source: "extracted" as const,
    ownership: [],
    status: "open" as const,
    checks: [],
    gddSha256: "e".repeat(64),
    gddRevision: 1,
  }));

const ctx = (): AcceptanceWriteContext => ({ milestoneId: "m2", workerModels: ["worker-model"], harnessDoc: harnessApiDoc(), surfaceDigest: SURFACE });

/** The reply an honest writer gives for the ROW ids its prompt names. */
function honestReply(user: string): string {
  const asked = [...user.matchAll(/^ROW (\S+)$/gm)].map((m) => m[1]!);
  const checks: AcceptanceCheckBody[] = asked.map((rid) => ({
    rid,
    body: `${NUNIT}.Assert.That(Service<global::Glow.ILives>().Count, ${NUNIT}.Is.EqualTo(2));`,
  }));
  return JSON.stringify({ checks, unbound: [] });
}

/**
 * A writer whose provider is `provider`: the scripted provider answers with a
 * fixed reply per call, so this wraps it to answer honestly for whatever rows
 * each call asks about, and keeps the usage the test scripted.
 */
function writerOver(provider: ScriptedProvider, streaming: boolean): AcceptanceAuthor {
  const inner = streaming ? provider.chatStream! : provider.chat;
  const answering = async (system: string, messages: Array<{ content: unknown }>, ...rest: unknown[]) => {
    const response = (await inner(system, messages, ...rest)) as { text: string };
    return { ...response, text: honestReply(String(messages.at(-1)?.content ?? "")) };
  };
  const answered = { ...provider, ...(streaming ? { chatStream: answering } : { chat: answering }) };
  const source: WriterProviderSource = {
    listExecutionCandidates: () => [{ name: PROVIDER, defaultModel: "writer-model" }],
    getProviderByName: () => answered as never,
  };
  return new AcceptanceAuthor({ providers: source, isHealthy: () => true, streaming });
}

describe("the acceptance writer bills the campaign's spend", () => {
  it("a batch books its tokens once on the streaming path: counters and one cost row, source chat, trigger acceptance-author", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "", usage: usage(2100, 640) }], { streaming: true });

    const result = await writerOver(provider, true).write(rows(2), ctx());

    expect(result.checks).toHaveLength(2);
    expect(provider.calls).toHaveLength(1);
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 2100, outputTokens: 640 }] });
  });

  it("with streaming off the chat() path bills the same way", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "", usage: usage(1800, 500) }]);

    const result = await writerOver(provider, false).write(rows(2), ctx());

    expect(result.checks).toHaveLength(2);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 1800, outputTokens: 500 }] });
  });

  it("a request over several batches bills one row per provider call, each at its own reply's cost", async () => {
    const n = WRITER_BATCH_ROWS * 2 + 1;
    const replies = [
      { text: "", usage: usage(3000, 900) },
      { text: "", usage: usage(2900, 880) },
      { text: "", usage: usage(400, 60) },
    ];
    const provider = scriptedProvider(PROVIDER, replies);

    const result = await writerOver(provider, false).write(rows(n), ctx());

    expect(result.calls).toBe(3);
    expect(provider.calls).toHaveLength(3);
    expectBilledAsCampaignWork(harness, {
      purpose: PURPOSE,
      provider: PROVIDER,
      calls: replies.map((r) => ({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })),
    });
  });

  it("a reply with no usage books nothing, counts nothing, and says it was not measured", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "" }]);

    const result = await writerOver(provider, false).write(rows(1), ctx());

    expect(result.checks).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(UNMEASURED_WARNING, expect.objectContaining({ purpose: PURPOSE }));
  });
});
