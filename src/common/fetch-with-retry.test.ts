import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./fetch-with-retry.js";

// Suppress logger output during tests
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../security/secret-sanitizer.js", () => ({
  sanitizeSecrets: (s: string) => s,
}));

describe("fetchWithRetry — AbortSignal handling", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("propagates abort immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Timeout"));

    // fetch will throw because signal is already aborted
    fetchSpy.mockRejectedValue(new Error("The operation was aborted"));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        signal: controller.signal,
        callerName: "TestCaller",
      },
    );

    await expect(promise).rejects.toThrow("The operation was aborted");

    // Should have called fetch exactly once — no retries
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries network errors without passing expired signal to sleep", async () => {
    // Simulate: first two calls fail with network error (signal NOT aborted),
    // third call succeeds
    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        callerName: "TestCaller",
        // No signal — but the key point is that sleep is called WITHOUT signal
      },
    );

    // Advance through first retry delay (100 * 2^0 = 100ms + jitter)
    await vi.advanceTimersByTimeAsync(250);
    // Advance through second retry delay (100 * 2^1 = 200ms + jitter)
    await vi.advanceTimersByTimeAsync(350);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries network errors even when signal was provided but not yet aborted", async () => {
    const controller = new AbortController();
    // Signal exists but is NOT aborted

    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        signal: controller.signal,
        callerName: "TestCaller",
      },
    );

    // Advance through retry delay
    await vi.advanceTimersByTimeAsync(250);

    const response = await promise;
    expect(response.ok).toBe(true);
    // First call failed, second succeeded
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry 429/5xx sleep with signal parameter", async () => {
    const controller = new AbortController();

    fetchSpy
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        signal: controller.signal,
        callerName: "TestCaller",
      },
    );

    // Advance through retry-after delay (1s)
    await vi.advanceTimersByTimeAsync(1100);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
