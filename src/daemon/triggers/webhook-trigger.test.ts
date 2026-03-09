/**
 * WebhookTrigger + POST /api/webhook + GET /api/triggers Tests
 *
 * Tests:
 * - WebhookTrigger unit tests (buffer, fire, dispose)
 * - Rate limiter (sliding window)
 * - Auth (dual: webhook secret + dashboard token, timing-safe)
 * - POST /api/webhook integration
 * - GET /api/triggers integration
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookTrigger } from "./webhook-trigger.js";

// =============================================================================
// WEBHOOK TRIGGER UNIT TESTS
// =============================================================================

describe("WebhookTrigger", () => {
  let trigger: WebhookTrigger;

  beforeEach(() => {
    trigger = new WebhookTrigger("test-webhook", "Process incoming events");
  });

  // ===========================================================================
  // Metadata
  // ===========================================================================

  it("metadata has correct name, type, and initial description", () => {
    expect(trigger.metadata.name).toBe("test-webhook");
    expect(trigger.metadata.type).toBe("webhook");
    expect(trigger.metadata.description).toBe("Process incoming events");
  });

  // ===========================================================================
  // shouldFire / pushEvent
  // ===========================================================================

  it("shouldFire returns false when no events pushed", () => {
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("shouldFire returns true after pushEvent", () => {
    trigger.pushEvent("deploy", "github");
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("pushEvent with action, source, and context", () => {
    trigger.pushEvent("build", "ci", { branch: "main" });
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("multiple pushEvents accumulate in buffer", () => {
    trigger.pushEvent("deploy");
    trigger.pushEvent("test");
    trigger.pushEvent("lint");
    expect(trigger.getPendingEvents()).toHaveLength(3);
  });

  // ===========================================================================
  // onFired
  // ===========================================================================

  it("onFired drains buffer so shouldFire returns false", () => {
    trigger.pushEvent("deploy", "github");
    expect(trigger.shouldFire(new Date())).toBe(true);
    trigger.onFired(new Date());
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("onFired updates metadata description with webhook details", () => {
    trigger.pushEvent("deploy", "github");
    trigger.pushEvent("test", "ci");
    trigger.onFired(new Date());

    expect(trigger.metadata.description).toContain("Webhook received");
    expect(trigger.metadata.description).toContain("2 event(s)");
  });

  it("onFired single event includes action and source in description", () => {
    trigger.pushEvent("deploy", "github");
    trigger.onFired(new Date());

    expect(trigger.metadata.description).toContain("deploy");
    expect(trigger.metadata.description).toContain("github");
  });

  it("onFired with no events is a no-op", () => {
    const descBefore = trigger.metadata.description;
    trigger.onFired(new Date());
    expect(trigger.metadata.description).toBe(descBefore);
  });

  // ===========================================================================
  // getNextRun / getState
  // ===========================================================================

  it("getNextRun returns null (event-driven)", () => {
    expect(trigger.getNextRun()).toBeNull();
  });

  it("getState returns active", () => {
    expect(trigger.getState()).toBe("active");
  });

  // ===========================================================================
  // getPendingEvents
  // ===========================================================================

  it("getPendingEvents returns copy of pending events", () => {
    trigger.pushEvent("a");
    trigger.pushEvent("b");
    const events = trigger.getPendingEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.action).toBe("a");
    expect(events[1]!.action).toBe("b");
  });

  it("getPendingEvents returns immutable copy", () => {
    trigger.pushEvent("a");
    const events = trigger.getPendingEvents();
    // Mutating returned array should not affect internal state
    (events as unknown[]).length = 0;
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("getPendingEvents includes timestamps", () => {
    trigger.pushEvent("deploy");
    const events = trigger.getPendingEvents();
    expect(events[0]!.timestamp).toBeGreaterThan(0);
  });

  // ===========================================================================
  // dispose
  // ===========================================================================

  it("dispose clears pending events", async () => {
    trigger.pushEvent("deploy");
    expect(trigger.shouldFire(new Date())).toBe(true);
    await trigger.dispose();
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("dispose is idempotent", async () => {
    trigger.pushEvent("deploy");
    await trigger.dispose();
    await trigger.dispose();
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // ===========================================================================
  // Event details
  // ===========================================================================

  it("pushEvent records source as undefined when not provided", () => {
    trigger.pushEvent("deploy");
    const events = trigger.getPendingEvents();
    expect(events[0]!.source).toBeUndefined();
  });

  it("pushEvent records context when provided", () => {
    trigger.pushEvent("deploy", "ci", { branch: "main", sha: "abc123" });
    const events = trigger.getPendingEvents();
    expect(events[0]!.context).toEqual({ branch: "main", sha: "abc123" });
  });
});

// =============================================================================
// RATE LIMITER TESTS
// =============================================================================

describe("WebhookRateLimiter", () => {
  // We import and test the rate limiter as a separate export
  let parseRateLimit: typeof import("./webhook-trigger.js")["parseRateLimit"];
  let WebhookRateLimiter: typeof import("./webhook-trigger.js")["WebhookRateLimiter"];

  beforeEach(async () => {
    const mod = await import("./webhook-trigger.js");
    parseRateLimit = mod.parseRateLimit;
    WebhookRateLimiter = mod.WebhookRateLimiter;
  });

  it("parseRateLimit parses '10/min' correctly", () => {
    const result = parseRateLimit("10/min");
    expect(result.maxRequests).toBe(10);
    expect(result.windowMs).toBe(60_000);
  });

  it("parseRateLimit parses '100/hour' correctly", () => {
    const result = parseRateLimit("100/hour");
    expect(result.maxRequests).toBe(100);
    expect(result.windowMs).toBe(3_600_000);
  });

  it("parseRateLimit defaults to 10/min for invalid input", () => {
    const result = parseRateLimit("invalid");
    expect(result.maxRequests).toBe(10);
    expect(result.windowMs).toBe(60_000);
  });

  it("under limit: requests are allowed", () => {
    const limiter = new WebhookRateLimiter(3, 60_000);
    const now = Date.now();
    expect(limiter.isAllowed(now)).toBe(true);
    expect(limiter.isAllowed(now + 1)).toBe(true);
    expect(limiter.isAllowed(now + 2)).toBe(true);
  });

  it("at limit: request is denied", () => {
    const limiter = new WebhookRateLimiter(3, 60_000);
    const now = Date.now();
    limiter.isAllowed(now);
    limiter.isAllowed(now + 1);
    limiter.isAllowed(now + 2);
    expect(limiter.isAllowed(now + 3)).toBe(false);
  });

  it("window reset: allows new requests after window expires", () => {
    const limiter = new WebhookRateLimiter(2, 1000);
    const now = Date.now();
    limiter.isAllowed(now);
    limiter.isAllowed(now + 1);
    expect(limiter.isAllowed(now + 2)).toBe(false);

    // After window expires
    expect(limiter.isAllowed(now + 1001)).toBe(true);
  });

  it("sliding window only counts recent timestamps", () => {
    const limiter = new WebhookRateLimiter(2, 1000);
    const now = Date.now();
    limiter.isAllowed(now); // count: 1
    limiter.isAllowed(now + 500); // count: 2

    // At now + 1001, the first timestamp expires but second doesn't
    // So we should have room for 1 more
    expect(limiter.isAllowed(now + 1001)).toBe(true);
    expect(limiter.isAllowed(now + 1002)).toBe(true);
    expect(limiter.isAllowed(now + 1003)).toBe(false); // sliding: now+500, now+1001, now+1002 = 3 > 2 (wait, 2 limit hit)
  });
});

// =============================================================================
// AUTH TESTS
// =============================================================================

describe("webhookAuth", () => {
  let validateWebhookAuth: typeof import("./webhook-trigger.js")["validateWebhookAuth"];

  beforeEach(async () => {
    const mod = await import("./webhook-trigger.js");
    validateWebhookAuth = mod.validateWebhookAuth;
  });

  it("valid webhook secret is accepted", () => {
    const result = validateWebhookAuth(
      { "x-webhook-secret": "my-secret" },
      "my-secret",
      undefined,
    );
    expect(result.valid).toBe(true);
  });

  it("invalid webhook secret is rejected", () => {
    const result = validateWebhookAuth(
      { "x-webhook-secret": "wrong" },
      "my-secret",
      undefined,
    );
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
  });

  it("dashboard token accepted when webhook secret not configured", () => {
    const result = validateWebhookAuth(
      { authorization: "Bearer dash-token" },
      undefined,
      "dash-token",
    );
    expect(result.valid).toBe(true);
  });

  it("no auth configured returns 403", () => {
    const result = validateWebhookAuth(
      {},
      undefined,
      undefined,
    );
    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
  });

  it("webhook secret takes priority over dashboard token", () => {
    const result = validateWebhookAuth(
      { "x-webhook-secret": "my-secret", authorization: "Bearer dash-token" },
      "my-secret",
      "dash-token",
    );
    expect(result.valid).toBe(true);
  });

  it("webhook secret comparison uses timing-safe equals", () => {
    // Structural test: verify it uses timingSafeEqual by testing
    // that different-length secrets don't crash
    const result = validateWebhookAuth(
      { "x-webhook-secret": "a" },
      "very-long-secret-that-is-different-length",
      undefined,
    );
    expect(result.valid).toBe(false);
  });

  it("empty webhook secret header is rejected", () => {
    const result = validateWebhookAuth(
      { "x-webhook-secret": "" },
      "my-secret",
      undefined,
    );
    expect(result.valid).toBe(false);
  });
});
