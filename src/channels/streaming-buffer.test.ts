import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamingBuffer } from "./streaming-buffer.js";

describe("StreamingBuffer – throttled flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes immediately when outside throttle window", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush });

    await buf.update("hello");

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("hello");
  });

  it("defers second update when inside throttle window, flush happens once", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush });

    // First update — immediate flush, sets lastUpdate.
    await buf.update("first");
    expect(onFlush).toHaveBeenCalledTimes(1);

    // Second update within the throttle window — should queue a deferred flush.
    await buf.update("second");
    expect(onFlush).toHaveBeenCalledTimes(1); // not yet

    // Advance past the throttle window.
    await vi.runAllTimersAsync();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith("second");
  });
});

describe("StreamingBuffer – finalize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onFinalize with final text and cancels pending deferred flush", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush, onFinalize });

    // Trigger a deferred flush (second update within window).
    await buf.update("partial");
    await buf.update("partial2"); // deferred

    // Finalize before the timer fires.
    await buf.finalize("FINAL");

    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(onFinalize).toHaveBeenCalledWith("FINAL");

    // Advance time — the deferred flush should NOT fire.
    await vi.runAllTimersAsync();

    // onFlush called once (for the first immediate update) and not again.
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("falls back to onFlush when no onFinalize provided", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush });

    await buf.finalize("FINAL");

    expect(onFlush).toHaveBeenCalledWith("FINAL");
  });

  it("subsequent update calls after finalize are no-ops", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush });

    await buf.finalize("FINAL");
    onFlush.mockClear();

    await buf.update("post-finalize");
    await vi.runAllTimersAsync();

    expect(onFlush).not.toHaveBeenCalled();
  });

  it("double finalize is a no-op for the second call", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush: vi.fn(), onFinalize });

    await buf.finalize("FINAL");
    await buf.finalize("IGNORED");

    expect(onFinalize).toHaveBeenCalledTimes(1);
  });
});

describe("StreamingBuffer – clearOnDisconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels pending deferred flush so no timer fires after disconnect", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush });

    // First flush sets lastUpdate.
    await buf.update("first");
    // Second update schedules a deferred timer.
    await buf.update("second");
    onFlush.mockClear();

    buf.clearOnDisconnect();

    await vi.runAllTimersAsync();

    // The deferred flush was cancelled — no additional calls.
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("makes subsequent updates no-ops", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new StreamingBuffer({ throttleMs: 1000, onFlush });

    buf.clearOnDisconnect();
    await buf.update("after disconnect");

    expect(onFlush).not.toHaveBeenCalled();
  });
});
