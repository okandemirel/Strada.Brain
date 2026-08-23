import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry } from "./fetch-with-retry.js";

/**
 * Our own abort is not the network failing.
 *
 * Callers pass their signal in the fetch init — openai.ts does at four call
 * sites — while the retry loop only ever asked `opts.signal?.aborted`. So a
 * stall watchdog or a task cancel looked exactly like a transport failure and
 * was retried: ten attempts backing off to a minute each, against a signal that
 * could never become un-aborted.
 *
 * Measured 2026-08-22, run 47: ten "network error, retrying" lines between
 * 20:23 and 22:09, every one carrying "This operation was aborted", ending in a
 * run that sat silent for four hours while the provider answered a direct
 * request in three seconds.
 *
 * These call the function. An earlier version of this file asserted on the
 * source text and passed both mutations, because the words it looked for were
 * in the comment explaining the fix.
 */

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../security/secret-sanitizer.js", () => ({ sanitizeSecrets: (s: string) => s }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function abortError(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

describe("an abort ends the attempt", () => {
  it("does not retry when the caller's signal — passed in init — aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw abortError();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.invalid/x", { signal: controller.signal }, {
        baseDelayMs: 1,
        networkMaxRetries: 5,
        callerName: "abort-init",
      }),
    ).rejects.toThrow(/aborted/iu);

    expect(fetchMock, "the aborted request was retried").toHaveBeenCalledTimes(1);
  });

  it("does not retry an AbortError even with no signal to inspect", async () => {
    const fetchMock = vi.fn(async () => {
      throw abortError();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.invalid/x", {}, {
        baseDelayMs: 1,
        networkMaxRetries: 5,
        callerName: "abort-nameonly",
      }),
    ).rejects.toThrow(/aborted/iu);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trusts the signal even when the thrown error does not mention aborting", async () => {
    // Isolates the init.signal half. Not every abort surfaces as an AbortError:
    // a wrapper can rethrow, and undici has worded this differently across
    // versions. With the signal already aborted there is nothing to retry
    // against, whatever the error happens to say.
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.invalid/x", { signal: controller.signal }, {
        baseDelayMs: 1,
        networkMaxRetries: 5,
        callerName: "abort-silent",
      }),
    ).rejects.toThrow();

    expect(fetchMock, "retried against a signal that can never un-abort").toHaveBeenCalledTimes(1);
  });

  it("still retries a genuine transport failure", async () => {
    // The loop's whole purpose; a fix that stopped retrying "fetch failed"
    // would be worse than the bug it replaces.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.invalid/x", {}, {
      baseDelayMs: 1,
      networkMaxRetries: 5,
      callerName: "transport",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
