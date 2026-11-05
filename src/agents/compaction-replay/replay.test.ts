/**
 * The offline A/B's accounting: what each arm sends, what a byte-prefix cache
 * would serve, and what that costs. The sessions are invented: a field guide
 * being summarised.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../providers/provider-core.interface.js";
import { headChurn, replayArm, replayFidelity, sharedPrefixTokens } from "./replay.js";
import type { ReplaySession, ReplayTurn } from "./transcript.js";

const words = (seed: string, chars: number): string => `${seed} `.repeat(Math.ceil(chars / (seed.length + 1))).slice(0, chars);
const say = (role: "user" | "assistant", seed: string, chars = 400): ConversationMessage => ({ role, content: words(seed, chars) });

/** 4 000 prompt chars: 1 000 head tokens; every 400-char message: 100 tokens. */
const call = (append: ConversationMessage[], extra: Partial<ReplayTurn> = {}): ReplayTurn => ({ promptChars: 4_000, toolChars: 0, append, ...extra });

const chat = (turns: ReplayTurn[]): ReplaySession => ({ id: "guide#1", turns });

function exchange(i: number, resultChars: number): ConversationMessage[] {
  const id = `call-${i}`;
  return [
    { role: "assistant", content: `Reading page ${i}.`, tool_calls: [{ id, name: "file_read", input: { path: `guide/page-${i}.md` } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: words(`page${i}`, resultChars) }] },
  ];
}

const PRICES = { contextWindow: 128_000, priceUncached: 1, priceCached: 0.02 };
const APPEND_ONLY = { name: "append-only", kind: "append-only" } as const;

describe("compaction replay", () => {
  it("sends the head and the whole history every call, and a cache serves everything the previous call sent", () => {
    const session = chat([call([say("user", "task")]), call([say("assistant", "a1"), say("user", "u1")]), call([say("assistant", "a2"), say("user", "u2")])]);
    const r = replayArm(APPEND_ONLY, [session], PRICES);
    expect(r).toMatchObject({ calls: 3, events: 0, backstops: 0, inputTokens: 1_100 + 1_300 + 1_500 });
    // Cold first call; then the head and every earlier message are a prefix of the next request.
    expect(r.cachedStableHead).toBe(0 + 1_100 + 1_300);
    expect(r.cachedLoggedHead).toBe(r.cachedStableHead);
    expect(r.costStableHead).toBeCloseTo(3_900 - 2_400 + 2_400 * 0.02);
    expect([r.requestMedian, r.requestP90, r.requestMax]).toEqual([1_300, 1_500, 1_500]);
  });

  it("under 'head as logged', a call whose system prompt or tool schemas changed size misses entirely", () => {
    const session = chat([
      call([say("user", "task")]),
      call([say("assistant", "a1"), say("user", "u1")], { promptChars: 4_400 }),
      call([say("assistant", "a2"), say("user", "u2")], { promptChars: 4_400, toolChars: 400 }),
      call([say("assistant", "a3"), say("user", "u3")], { promptChars: 4_400, toolChars: 400 }),
    ]);
    const r = replayArm(APPEND_ONLY, [session], PRICES);
    // Heads: 1 000, 1 100, 1 200, 1 200 tokens. Only the fourth call keeps the previous call's head.
    expect(r.cachedLoggedHead).toBe(1_200 + 500);
    expect(r.cachedStableHead).toBe((1_100 + 100) + (1_200 + 300) + (1_200 + 500));
    expect(headChurn([session])).toEqual({ transitions: 3, promptChanged: 1, toolsChanged: 1 });
  });

  it("counts a rewritten message as cached only up to its first changed character", () => {
    const piece = (text: string, tokens: number) => ({ text, tokens });
    const prev = [piece("aaaa", 10), piece("bbbbbbbb", 20), piece("cccc", 10)];
    expect(sharedPrefixTokens(prev, [...prev, piece("dddd", 10)])).toBe(40);
    expect(sharedPrefixTokens(prev, [prev[0]!, piece("bbbbXXXX", 20), prev[2]!])).toBe(10 + 10);
    expect(sharedPrefixTokens(prev, [piece("zzzz", 10), ...prev.slice(1)])).toBe(0);
  });

  it("runs the live decision in the current arm, and sends less than append-only once it compacts", () => {
    const session = chat([call([say("user", "task")]), ...Array.from({ length: 24 }, (_, i) => call(exchange(i, 4_000)))]);
    const opts = { ...PRICES, contextWindow: 20_000 };
    const reference = replayArm(APPEND_ONLY, [session], opts);
    const current = replayArm({ name: "current", kind: "current" }, [session], opts);
    expect(reference.events).toBe(0);
    expect(current.events).toBeGreaterThan(0);
    expect(current.inputTokens).toBeLessThan(reference.inputTokens);
    // The live trigger is 70% of the window: no request the current arm sends goes far past it.
    expect(current.requestMax).toBeLessThan(0.7 * 20_000 + 1_500);
    expect(reference.requestMax).toBeGreaterThan(20_000);
  });

  it("counts the cliff's events, and a backstop when the cliff cannot make room under the live window", () => {
    const masks = chat([call([say("user", "task")]), ...Array.from({ length: 24 }, (_, i) => call(exchange(i, 4_000)))]);
    const cliff = { name: "cliff", kind: "cliff", cliff: { triggerTokens: 8_000, floorTokens: 3_000, minReclaimTokens: 1_000 } } as const;
    const r = replayArm(cliff, [masks], PRICES);
    expect(r.events).toBeGreaterThan(0);
    expect(r.backstops).toBe(0);
    // Results of 500 characters or less are never masked: under a small window only the live pipeline can cut.
    const small = chat([call([say("user", "task")]), ...Array.from({ length: 80 }, (_, i) => call(exchange(i, 480)))]);
    const tight = replayArm(cliff, [small], { ...PRICES, contextWindow: 12_000 });
    expect(tight.events).toBe(0);
    expect(tight.backstops).toBeGreaterThan(0);
  });

  it("fires the cliff before the live window would compact, even when its own trigger is higher", () => {
    const session = chat([call([say("user", "task")]), ...Array.from({ length: 40 }, (_, i) => call(exchange(i, 4_000)))]);
    const high = { name: "cliff", kind: "cliff", cliff: { triggerTokens: 50_000, floorTokens: 10_000, minReclaimTokens: 1_000 } } as const;
    const r = replayArm(high, [session], { ...PRICES, contextWindow: 20_000 });
    expect(r.events).toBeGreaterThan(0);
    expect(r.backstops).toBe(0);
    expect(r.requestMax).toBeLessThanOrEqual(0.7 * 20_000 + 1_100);
  });

  it("checks fidelity against the logged input up to the session's first live cut", () => {
    const session = chat([
      call([say("user", "task")], { inputTokens: 1_100 }),
      call([say("assistant", "a1"), say("user", "u1")], { inputTokens: 1_300 }),
      call([say("assistant", "a2"), say("user", "u2")], { inputTokens: 1_650 }),
      call([say("assistant", "a3"), say("user", "u3")], { inputTokens: 1_000, liveCut: true }),
      call([say("assistant", "a4"), say("user", "u4")], { inputTokens: 1_200 }),
    ]);
    const f = replayFidelity([session]);
    expect(f.calls).toBe(3);
    expect(f.medianAbsError).toBe(0);
    expect(f.p90AbsError).toBeCloseTo(150 / 1_650);
    expect(replayFidelity([chat([call([say("user", "task")])])])).toEqual({ calls: 0, medianAbsError: null, p90AbsError: null });
  });
});
