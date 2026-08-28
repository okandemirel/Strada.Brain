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
