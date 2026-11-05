/**
 * The threshold-cliff design the offline A/B replays
 * (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md):
 * rare, byte-stable rewrites that keep what the model needs. The histories are
 * invented: a field guide being summarised.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage, MessageContent } from "../providers/provider-core.interface.js";
import { estimateTokens } from "../session-compaction.js";
import { STUB_PREFIX, effectiveTrigger, failureLines, planCliff, resultStub } from "./threshold-cliff.js";

const words = (seed: string, chars: number): string => `${seed} `.repeat(Math.ceil(chars / (seed.length + 1))).slice(0, chars);

function exchange(i: number, resultChars: number, opts: { failed?: boolean; inputChars?: number } = {}): ConversationMessage[] {
  const id = `call-${i}`;
  const input = opts.inputChars
    ? { path: `guide/page-${i}.md`, body: words(`body${i}`, opts.inputChars) }
    : { path: `guide/page-${i}.md` };
  const content = `${opts.failed ? `Error: page ${i} failed to parse\n` : ""}${words(`result${i}`, resultChars)}`;
  return [
    { role: "assistant", content: `Reading page ${i} next.`, tool_calls: [{ id, name: "file_read", input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: opts.failed === true }] },
  ];
}

const TASK: ConversationMessage = { role: "user", content: "Summarise the field guide to coastal birds." };

/** The task, then `n` reads of `chars` characters each: about chars / 4 tokens per result. */
const history = (n: number, chars = 4_000): ConversationMessage[] => [TASK, ...Array.from({ length: n }, (_, i) => exchange(i, chars)).flat()];

const resultsOf = (messages: readonly ConversationMessage[]): string[] =>
  messages.flatMap((m) => (m.role === "user" && typeof m.content !== "string" ? m.content : []))
    .filter((b): b is Extract<MessageContent, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => b.content);

const OPTS = { triggerTokens: 10_000, floorTokens: 12_000, minReclaimTokens: 1_000 };

describe("threshold cliff", () => {
  it("makes no event at or under the trigger: the history stays append-only", () => {
    const h = history(5);
    expect(estimateTokens(h)).toBeLessThan(10_000);
    expect(planCliff(h, { triggerTokens: 10_000, floorTokens: 4_000, minReclaimTokens: 500 })).toBeNull();
  });

  it("masks the oldest results first, stops at the floor, and keeps the newest ten verbatim", () => {
    const h = history(20);
    const event = planCliff(h, { ...OPTS, triggerTokens: 15_000 })!;
    expect(event).not.toBeNull();
    const after = resultsOf(event.messages);
    const before = resultsOf(h);
    const masked = after.map((r) => r.startsWith(STUB_PREFIX));
    const firstKept = masked.indexOf(false);
    // Oldest-first: every stub precedes every verbatim result.
    expect(masked.slice(0, firstKept).every(Boolean)).toBe(true);
    expect(masked.slice(firstKept).some(Boolean)).toBe(false);
    expect(after.slice(-10)).toEqual(before.slice(-10));
    expect(event.afterTokens).toBeLessThanOrEqual(12_000);
    expect(event.afterTokens).toBe(estimateTokens(event.messages));
    expect(event.masked).toBe(firstKept);
  });

  it("never masks the task, a user turn, the reasoning, or a result of 500 characters or less", () => {
    const note: ConversationMessage = { role: "user", content: words("Also list the nesting months", 2_000) };
    const h = [TASK, ...exchange(0, 450), note, ...Array.from({ length: 14 }, (_, i) => exchange(i + 1, 4_000)).flat()];
    const event = planCliff(h, { triggerTokens: 1_000, floorTokens: 0, minReclaimTokens: 100 })!;
    expect(event.messages[0]).toBe(TASK);
    expect(event.messages[3]).toBe(note);
    expect(resultsOf(event.messages)[0]).toBe(resultsOf(h)[0]);
    const texts = (ms: readonly ConversationMessage[]) => ms.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(texts(event.messages)).toEqual(texts(h));
  });

  it("writes a stub that names the call that fetches the content again and keeps every failure line", () => {
    const content = "Error: page 3 failed to parse\nline two is fine\nfatal: the index is missing\nline four";
    const stub = resultStub({ name: "file_read", input: { path: "guide/page-3.md" } }, content, true);
    expect(stub.split("\n")).toEqual([
      `${STUB_PREFIX}tool result: ${content.length} chars, failed. Re-fetch with: file_read {"path":"guide/page-3.md"}]`,
      "Error: page 3 failed to parse",
      "fatal: the index is missing",
    ]);
    expect(failureLines("no named problem here\nsecond line", true)).toEqual(["no named problem here"]);
    expect(failureLines("all fine\nstill fine", false)).toEqual([]);
  });

  it("gives the same bytes for the same history, and a later event leaves earlier stubs and the prefix untouched", () => {
    const h = history(20);
    const first = planCliff(h, OPTS)!;
    expect(planCliff(h, OPTS)).toEqual(first);
    const grown = [...first.messages, ...Array.from({ length: 30 }, (_, i) => exchange(100 + i, 4_000)).flat()];
    const second = planCliff(grown, OPTS, { lastAfterTokens: first.afterTokens })!;
    expect(second).not.toBeNull();
    const firstChanged = second.messages.findIndex((m, i) => m !== grown[i]);
    // Everything the first event masked sits before the first message the second one rewrote.
    const lastStubOfFirst = first.messages.findLastIndex((m) => resultsOf([m]).some((r) => r.startsWith(STUB_PREFIX)));
    expect(firstChanged).toBeGreaterThan(lastStubOfFirst);
    expect(second.messages.slice(0, firstChanged)).toEqual(grown.slice(0, firstChanged));
  });

  it("does not rewrite the history for less than the minimum reclaim", () => {
    const h = [...history(11, 600)];
    expect(estimateTokens(h)).toBeGreaterThan(1_000);
    // Only the oldest result is not among the newest ten: masking it saves far less than 5 000 tokens.
    expect(planCliff(h, { triggerTokens: 1_000, floorTokens: 0, minReclaimTokens: 5_000 })).toBeNull();
  });

  it("waits for (trigger - floor) of growth after an event, and never past the live window's ceiling", () => {
    const opts = { triggerTokens: 10_000, floorTokens: 5_000, minReclaimTokens: 1_000 };
    expect(effectiveTrigger(opts)).toBe(10_000);
    expect(effectiveTrigger(opts, { lastAfterTokens: 9_000 })).toBe(14_000);
    expect(effectiveTrigger(opts, { lastAfterTokens: 9_000, ceilingTokens: 12_000 })).toBe(12_000);
    const h = history(12);
    const tokens = estimateTokens(h);
    expect(tokens).toBeGreaterThan(10_000);
    expect(tokens).toBeLessThan(14_000);
    expect(planCliff(h, opts, { lastAfterTokens: 9_000 })).toBeNull();
    expect(planCliff(h, opts, { lastAfterTokens: 9_000, ceilingTokens: 10_000 })).not.toBeNull();
  });

  it("stubs long call inputs only when observations cannot reach the floor, never the latest call's", () => {
    const h = [TASK, ...Array.from({ length: 12 }, (_, i) => exchange(i, 300, { inputChars: 3_000 })).flat()];
    const inputsOf = (ms: readonly ConversationMessage[]) =>
      ms.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.input) : []));
    const stub = `${STUB_PREFIX}input field: 3000 chars]`;

    // The newest ten calls keep their input: their results are protected. The two older ones are stubbed.
    const kept = inputsOf(planCliff(h, { triggerTokens: 1_000, floorTokens: 0, minReclaimTokens: 100 })!.messages);
    expect(kept.map((i) => i.body === stub)).toEqual([true, true, ...Array<boolean>(10).fill(false)]);
    expect(kept.slice(0, 2).map((i) => i.path)).toEqual(["guide/page-0.md", "guide/page-1.md"]);

    // With no protected results, every input but the latest call's is stubbed.
    const bare = inputsOf(planCliff(h, { triggerTokens: 1_000, floorTokens: 0, minReclaimTokens: 100, keepRecentResults: 0 })!.messages);
    expect(bare.map((i) => i.body === stub)).toEqual([...Array<boolean>(11).fill(true), false]);
    expect(bare.at(-1)).toBe(inputsOf(h).at(-1));
  });
});
