import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  configureProviderConcurrency,
  __resetProviderConcurrency,
  QuotaExhaustedError,
  type BackoffInfo,
} from "./fetch-with-retry.js";

// Suppress logger output during tests
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

describe("fetchWithRetry — an outage is not a refusal", () => {
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

  it("outlasts a network outage longer than the status-retry budget", async () => {
    // Measured 2026-08-21: three status retries were spent in 3.5 seconds while
    // the internet was down, and the run settled as blocked:ask_user.
    for (let i = 0; i < 6; i++) fetchSpy.mockRejectedValueOnce(new Error("fetch failed"));
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, callerName: "TestCaller" },
    );

    // Six backoffs at 100 * 2^n, well past what maxRetries: 3 would have allowed.
    await vi.advanceTimersByTimeAsync(60_000);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });

  it("still gives up once the network budget is genuinely spent", async () => {
    fetchSpy.mockRejectedValue(new Error("fetch failed"));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, networkMaxRetries: 2, callerName: "TestCaller" },
    );
    const assertion = expect(promise).rejects.toThrow("fetch failed");

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("caps a single backoff so patience never becomes a hang", async () => {
    fetchSpy.mockRejectedValue(new Error("fetch failed"));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 10_000, networkMaxRetries: 2, networkMaxDelayMs: 1_000, callerName: "T" },
    );
    const assertion = expect(promise).rejects.toThrow("fetch failed");

    // Uncapped, the first backoff alone would be 10s; capped it is 1s.
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("propagates an abort during a network backoff instead of waiting it out", async () => {
    const controller = new AbortController();
    fetchSpy.mockImplementation(() => {
      if (controller.signal.aborted) throw new Error("The operation was aborted");
      throw new Error("fetch failed");
    });

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, callerName: "TestCaller", signal: controller.signal },
    );
    const assertion = expect(promise).rejects.toThrow("aborted");

    controller.abort(new Error("The operation was aborted"));
    await vi.advanceTimersByTimeAsync(5_000);
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

// A 429 whose Retry-After exceeds our ENTIRE retry budget (maxRetries * maxDelayMs) is a
// HARD QUOTA STOP — retrying is futile (the provider won't recover within our window). It
// must fail FAST with a non-retryable QuotaExhaustedError (no further attempts), while a
// SHORT Retry-After 429 still retries exactly as before (regression guard for 1d425fa).
describe("fetchWithRetry — hard quota stop (429 with Retry-After >> retry budget)", () => {
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

  it("throws a non-retryable QuotaExhaustedError WITHOUT exhausting retries", async () => {
    // OpenCode-style weekly-limit body + a ~3.23-day Retry-After (279094s). With
    // maxRetries=3 and maxDelayMs=60000 the budget is 180000ms; 279094000ms is far over
    // it → hard stop on the FIRST response (attempt count == 1, not maxRetries).
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { type: "GoUsageLimitError", message: "Weekly usage limit reached. Resets in 3 days." } }),
        { status: 429, headers: { "retry-after": "279094" } },
      ),
    );

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 60_000, callerName: "OpenCode (Zen/Go)" },
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(QuotaExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;

    // No retry sleeps happened — exactly ONE fetch, the hard stop fired immediately.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a distinct 'usage quota exhausted (resets in ~Xd)' reason enriched from the body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { type: "GoUsageLimitError", message: "Weekly usage limit reached. Resets in 3 days." } }),
        { status: 429, headers: { "retry-after": "279094" } },
      ),
    );

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 60_000, callerName: "OpenCode (Zen/Go)" },
    );
    let captured: unknown;
    const assertion = promise.catch((e: unknown) => { captured = e; });
    await vi.runAllTimersAsync();
    await assertion;

    expect(captured).toBeInstanceOf(QuotaExhaustedError);
    const err = captured as QuotaExhaustedError;
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe("OpenCode (Zen/Go)");
    expect(err.retryAfterMs).toBe(279_094_000);
    // Distinct, accurate wording — NOT "rate-limited", NOT "unresponsive".
    expect(err.message).toMatch(/usage quota exhausted \(resets in ~3d\)/i);
    // Secondary body enrichment carries the human reason.
    expect(err.message).toContain("Weekly usage limit reached");
    expect(err.message).not.toMatch(/rate-limited|unresponsive/i);
  });

  it("a 429 with a SHORT Retry-After still retries exactly as before (regression guard for 1d425fa)", async () => {
    // Retry-After of 1s is WELL within the 180000ms budget → transient path unchanged:
    // it backs off and retries, then succeeds. No QuotaExhaustedError.
    fetchSpy
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 60_000, callerName: "TestCaller" },
    );

    await vi.advanceTimersByTimeAsync(1100);
    const response = await promise;
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("a 429 with NO Retry-After is treated as transient (never a hard stop)", async () => {
    // Without a Retry-After header there is no futility signal → the existing
    // exponential-backoff retry path runs (no QuotaExhaustedError).
    fetchSpy
      .mockResolvedValueOnce(new Response("too many requests", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(
      "https://example.com/api",
      { method: "GET" },
      { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 60_000, callerName: "TestCaller" },
    );

    await vi.advanceTimersByTimeAsync(500);
    const response = await promise;
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// Audited 2026-09-02: the body-carried reset was consulted ONLY when Retry-After
// was absent. A 429 with `Retry-After: 60` and a body saying the plan resets in
// 6.7 days therefore never hard-stopped: the wrapper slept 60s three times, threw
// a plain "rate-limited (HTTP 429)", and the FallbackChain filed it as a 5-10
// minute overload instead of the multi-day quota stop the provider had stated.
// The two sources are reconciled: the LONGER reset drives the futility gate.
describe("fetchWithRetry — a short Retry-After does not hide a long body-carried reset", () => {
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

  const opts = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 60_000, callerName: "OpenAI" };

  it("hard-stops on the body reset when the header alone would fit the retry budget", async () => {
    // Retry-After 60s is inside the 180000ms budget; resets_in_seconds 580320
    // (~6.7 days) is not. The body is the authoritative one.
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ type: "usage_limit_reached", resets_in_seconds: 580_320 }),
        { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
      ),
    );

    const promise = fetchWithRetry("https://example.com/api", { method: "GET" }, opts);
    let captured: unknown;
    const assertion = promise.catch((e: unknown) => { captured = e; });
    await vi.runAllTimersAsync();
    await assertion;

    expect(captured, "retried through the budget instead of hard-stopping").toBeInstanceOf(QuotaExhaustedError);
    const err = captured as QuotaExhaustedError;
    // The cooldown is sized from the reset the provider actually stated, not the header.
    expect(err.retryAfterMs).toBe(580_320_000);
    expect(err.message).toMatch(/usage quota exhausted \(resets in ~7d\)/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the header when it is the longer of the two", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ type: "usage_limit_reached", resets_in_seconds: 5_640 }),
        { status: 429, headers: { "retry-after": "279094" } },
      ),
    );

    const promise = fetchWithRetry("https://example.com/api", { method: "GET" }, opts);
    let captured: unknown;
    const assertion = promise.catch((e: unknown) => { captured = e; });
    await vi.runAllTimersAsync();
    await assertion;

    expect(captured).toBeInstanceOf(QuotaExhaustedError);
    expect((captured as QuotaExhaustedError).retryAfterMs).toBe(279_094_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still retries when BOTH header and body resets fit inside the budget", async () => {
    // Neither source says the wait is futile → the transient path is unchanged,
    // and the short header still sizes the immediate backoff.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ type: "usage_limit_reached", resets_in_seconds: 30 }),
          { status: 429, headers: { "retry-after": "1" } },
        ),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry("https://example.com/api", { method: "GET" }, opts);
    await vi.advanceTimersByTimeAsync(1_100);
    const response = await promise;
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
