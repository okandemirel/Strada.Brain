import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  configureProviderConcurrency,
  __resetProviderConcurrency,
  type BackoffInfo,
} from "./fetch-with-retry.js";

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
    // These tests resolve the returned Response but never consume its body, which (by
    // design) holds the per-provider permit open. Reset the limiter between tests so a
    // held permit from one test can't exhaust the cap and hang the next.
    __resetProviderConcurrency();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetProviderConcurrency();
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

  it("fires onBackoff with status 429 and the Retry-After delay before retrying", async () => {
    const onBackoff = vi.fn();
    fetchSpy
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, callerName: "TestCaller", onBackoff },
    );

    await vi.advanceTimersByTimeAsync(2100);
    const response = await promise;

    expect(response.ok).toBe(true);
    // Retry-After of 2s is honored verbatim (not the exponential default). The 429 also
    // carries rate-limit diagnostics (asserted in the dedicated surfacing suite below).
    expect(onBackoff).toHaveBeenCalledTimes(1);
    expect(onBackoff).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, delayMs: 2000 }),
    );
  });

  it("throws an honest rate-limited (HTTP 429) error when 429 retries are exhausted", async () => {
    // Every attempt returns 429 → retries exhaust → terminal error must classify as
    // rate-limited, not a generic API error or an unresponsive endpoint.
    fetchSpy.mockResolvedValue(
      new Response("too many requests", { status: 429, headers: { "retry-after": "1" } }),
    );

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 1, baseDelayMs: 100, callerName: "OpenCode (Zen/Go)" },
    );
    // Attach the rejection handler synchronously so advancing timers can't surface an
    // unhandled rejection between ticks.
    const assertion = expect(promise).rejects.toThrow(/rate-limited \(HTTP 429\)/i);

    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  });
});

describe("fetchWithRetry — per-provider concurrency limiter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    __resetProviderConcurrency();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetProviderConcurrency();
  });

  /** A 200 response whose body resolves only when `release()` is called. */
  function gatedResponse(): { response: Response; release: () => void } {
    let release!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
        };
      },
    });
    return { response: new Response(body, { status: 200 }), release };
  }

  it("never exceeds the cap of in-flight calls to the SAME provider", async () => {
    configureProviderConcurrency(2);

    let inFlight = 0;
    let maxInFlight = 0;
    const pendingReleases: Array<() => void> = [];

    fetchSpy.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const { response, release } = gatedResponse();
      pendingReleases.push(() => {
        inFlight--;
        release();
      });
      return Promise.resolve(response);
    });

    // Fire 6 calls to the SAME provider; cap is 2. Each fully consumes its body, which
    // releases the permit so the next queued call can acquire.
    const calls = Array.from({ length: 6 }, () =>
      fetchWithRetry("https://example.com/api", { method: "GET" }, { callerName: "ProviderA" })
        .then((r) => r.text()),
    );

    // Drain loop: at any instant at most `cap` fetches are in flight. Repeatedly let the
    // event loop settle, snapshot the cap invariant, then release every fetch that has
    // started but not yet completed. This frees permits for queued calls one wave at a
    // time until all 6 have run.
    for (let i = 0; i < 12 && fetchSpy.mock.calls.length < 6; i++) {
      await Promise.resolve();
      await Promise.resolve();
      expect(maxInFlight).toBeLessThanOrEqual(2);
      while (pendingReleases.length > 0) pendingReleases.shift()!();
    }
    // Release any stragglers, then await all calls to settle.
    while (pendingReleases.length > 0) pendingReleases.shift()!();
    await Promise.all(calls);
    // Flush in case the final release admitted a last queued call.
    while (pendingReleases.length > 0) pendingReleases.shift()!();

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("releases a permit when the call throws (no leak)", async () => {
    configureProviderConcurrency(1);

    // First call rejects on every fetch attempt (network error, signal aborted → no retry).
    const aborted = new AbortController();
    aborted.abort(new Error("boom"));
    fetchSpy.mockRejectedValueOnce(new Error("boom"));

    await expect(
      fetchWithRetry(
        "https://example.com/api",
        { method: "GET" },
        { callerName: "ProviderThrow", signal: aborted.signal },
      ),
    ).rejects.toThrow("boom");

    // If the permit leaked, this second call (cap 1) would hang forever. It must resolve.
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const second = await fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { callerName: "ProviderThrow" },
    );
    expect(second.ok).toBe(true);
  });

  it("runs DIFFERENT providers concurrently — they do not block each other", async () => {
    configureProviderConcurrency(1);

    const started: string[] = [];
    const releases = new Map<string, () => void>();

    fetchSpy.mockImplementation((url: string, init: RequestInit & { __name?: string }) => {
      const name = init.__name ?? "?";
      started.push(name);
      const { response, release } = gatedResponse();
      releases.set(name, release);
      return Promise.resolve(response);
    });

    // Cap is 1 PER provider, so one call to A and one to B should BOTH be in flight.
    const a = fetchWithRetry(
      "https://a.example.com",
      { method: "GET", __name: "A" } as RequestInit,
      { callerName: "ProviderA" },
    ).then((r) => r.text());
    const b = fetchWithRetry(
      "https://b.example.com",
      { method: "GET", __name: "B" } as RequestInit,
      { callerName: "ProviderB" },
    ).then((r) => r.text());

    await Promise.resolve();
    await Promise.resolve();

    // Both providers' fetches started despite a per-provider cap of 1 — proves they
    // use independent semaphores and run concurrently.
    expect(started).toContain("A");
    expect(started).toContain("B");

    releases.get("A")!();
    releases.get("B")!();
    await Promise.all([a, b]);
  });
});

describe("fetchWithRetry — 429 diagnostics surfacing", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
    __resetProviderConcurrency();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetProviderConcurrency();
  });

  it("surfaces rate-limit headers + truncated body via onBackoff (never auth headers)", async () => {
    const backoffCalls: BackoffInfo[] = [];
    const onBackoff = (info: BackoffInfo): void => { backoffCalls.push(info); };

    const longBody = "rate limit exceeded: ".repeat(60); // > 500 chars
    fetchSpy
      .mockResolvedValueOnce(
        new Response(longBody, {
          status: 429,
          headers: {
            "retry-after": "1",
            "x-ratelimit-limit-requests": "60",
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-limit-tokens": "100000",
            "x-ratelimit-remaining-tokens": "42",
            "x-concurrency-limit": "3",
            // These must NOT be surfaced:
            authorization: "Bearer sk-secret-token-should-never-leak",
            "x-api-key": "sk-another-secret",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, callerName: "OpenCode (Zen/Go)", onBackoff },
    );

    await vi.advanceTimersByTimeAsync(1100);
    const response = await promise;
    expect(response.ok).toBe(true);

    expect(backoffCalls).toHaveLength(1);
    const info = backoffCalls[0]!;
    expect(info.status).toBe(429);
    expect(info.rateLimit).toBeDefined();

    const { headers, body } = info.rateLimit!;
    // Rate-limit headers ARE surfaced.
    expect(headers["retry-after"]).toBe("1");
    expect(headers["x-ratelimit-limit-requests"]).toBe("60");
    expect(headers["x-ratelimit-remaining-requests"]).toBe("0");
    expect(headers["x-ratelimit-remaining-tokens"]).toBe("42");
    expect(headers["x-concurrency-limit"]).toBe("3");

    // Auth headers / secrets are NEVER surfaced.
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("x-api-key");
    const serialized = JSON.stringify(info.rateLimit);
    expect(serialized).not.toContain("sk-secret-token-should-never-leak");
    expect(serialized).not.toContain("sk-another-secret");

    // Body is captured but truncated to <= 500 chars.
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body).toContain("rate limit exceeded");
  });

  it("does not attach rateLimit diagnostics for a non-429 retryable status (503)", async () => {
    const backoffCalls: BackoffInfo[] = [];
    const onBackoff = (info: BackoffInfo): void => { backoffCalls.push(info); };

    fetchSpy
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, callerName: "TestCaller", onBackoff },
    );

    await vi.advanceTimersByTimeAsync(250);
    const response = await promise;
    expect(response.ok).toBe(true);

    expect(backoffCalls).toHaveLength(1);
    expect(backoffCalls[0]!.status).toBe(503);
    expect(backoffCalls[0]!.rateLimit).toBeUndefined();
  });
});
