import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { notifyTaskLiveness, subscribeTaskLiveness } from "./liveness-hub.js";

describe("liveness-hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays activity to the subscriber for the same chatId", () => {
    const seen = vi.fn();
    const unsub = subscribeTaskLiveness("chat-a", seen);
    notifyTaskLiveness("chat-a");
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not relay across chatIds", () => {
    const seen = vi.fn();
    const unsub = subscribeTaskLiveness("chat-a", seen);
    notifyTaskLiveness("chat-b");
    expect(seen).not.toHaveBeenCalled();
    unsub();
  });

  it("throttles bursts to one notification per interval, then re-arms", () => {
    const seen = vi.fn();
    const unsub = subscribeTaskLiveness("chat-a", seen);
    notifyTaskLiveness("chat-a");
    notifyTaskLiveness("chat-a");
    notifyTaskLiveness("chat-a");
    expect(seen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(21_000);
    notifyTaskLiveness("chat-a");
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("stops relaying after unsubscribe", () => {
    const seen = vi.fn();
    const unsub = subscribeTaskLiveness("chat-a", seen);
    unsub();
    notifyTaskLiveness("chat-a");
    expect(seen).not.toHaveBeenCalled();
  });

  it("a throwing listener does not break the notifier or other listeners", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const unsubBad = subscribeTaskLiveness("chat-a", bad);
    const unsubGood = subscribeTaskLiveness("chat-a", good);
    expect(() => notifyTaskLiveness("chat-a")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    unsubBad();
    unsubGood();
  });

  it("throttle state resets when the last subscriber for a chat leaves", () => {
    const first = vi.fn();
    const unsubFirst = subscribeTaskLiveness("chat-a", first);
    notifyTaskLiveness("chat-a");
    unsubFirst();
    // New task on the same chat immediately after: must not inherit the old throttle window.
    const second = vi.fn();
    const unsubSecond = subscribeTaskLiveness("chat-a", second);
    notifyTaskLiveness("chat-a");
    expect(second).toHaveBeenCalledTimes(1);
    unsubSecond();
  });
});

describe("withLivenessHeartbeat — a long model call keeps the watchdog fed (2026-09-09: aborted at 20 min during two 640 s decompositions)", () => {
  it("ticks the chat's listeners and the extra hook at once and on every interval until the call settles", async () => {
    vi.useFakeTimers();
    try {
      const { subscribeTaskLiveness, withLivenessHeartbeat } = await import("./liveness-hub.js");
      let ticks = 0;
      let extra = 0;
      const unsubscribe = subscribeTaskLiveness("chat-hb", () => { ticks += 1; });
      let settle!: (v: string) => void;
      const pending = new Promise<string>((resolve) => { settle = resolve; });
      const running = withLivenessHeartbeat("chat-hb", () => pending, () => { extra += 1; }, 30_000);
      expect(extra).toBe(1);
      await vi.advanceTimersByTimeAsync(95_000);
      // Listener notifications are throttled to one per 20 s; the extra hook is not.
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect(extra).toBe(4);
      settle("done");
      expect(await running).toBe("done");
      const afterTicks = ticks;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ticks).toBe(afterTicks);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("both decomposition call sites run under the heartbeat", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const brain = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const proactive = readFileSync("src/agents/orchestrator-goal-decomposition.ts", "utf8");
    expect(brain).toContain("withLivenessHeartbeat(\n        context.chatId,\n        () => this.decomposer.decomposeProactive(");
    expect(proactive).toContain("withLivenessHeartbeat(opts.chatId, () =>\n      deps.goalDecomposer!.decomposeProactive(");
  });
});
