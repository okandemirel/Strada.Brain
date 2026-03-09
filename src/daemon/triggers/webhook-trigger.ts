/**
 * WebhookTrigger
 *
 * Implements ITrigger using an event buffer pattern (same as FileWatchTrigger).
 * External HTTP POSTs push events via pushEvent(); shouldFire() returns true
 * when the buffer is non-empty. onFired() drains the buffer and updates the
 * metadata description with webhook details for LLM context.
 *
 * Also exports:
 * - WebhookRateLimiter: sliding-window rate limiter for the webhook endpoint
 * - parseRateLimit: parses '10/min' style rate limit strings
 * - validateWebhookAuth: dual auth (webhook secret OR dashboard token) with timing-safe comparison
 *
 * Used by: TriggerRegistry, HeartbeatLoop, DashboardServer
 */

import { timingSafeEqual } from "node:crypto";
import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
} from "../daemon-types.js";

// =============================================================================
// WEBHOOK EVENT
// =============================================================================

/** Internal representation of a webhook event */
export interface WebhookEvent {
  readonly action: string;
  readonly source?: string;
  readonly context?: Record<string, unknown>;
  readonly timestamp: number;
}

// =============================================================================
// WEBHOOK TRIGGER
// =============================================================================

export class WebhookTrigger implements ITrigger {
  private _metadata: TriggerMetadata;
  private readonly pendingEvents: WebhookEvent[] = [];
  private readonly defaultAction: string;

  constructor(name: string, defaultAction: string) {
    this.defaultAction = defaultAction;
    this._metadata = {
      name,
      description: defaultAction,
      type: "webhook",
    };
  }

  /**
   * Push an event into the buffer. Called from POST /api/webhook handler.
   */
  pushEvent(
    action: string,
    source?: string,
    context?: Record<string, unknown>,
  ): void {
    this.pendingEvents.push({
      action,
      source,
      context,
      timestamp: Date.now(),
    });
  }

  /**
   * ITrigger.metadata -- dynamic getter allows description to change after onFired.
   */
  get metadata(): TriggerMetadata {
    return this._metadata;
  }

  /**
   * Returns true when there are pending webhook events to process.
   */
  shouldFire(_now: Date): boolean {
    return this.pendingEvents.length > 0;
  }

  /**
   * Called after the trigger fires. Drains the event buffer and updates
   * the metadata description with a summary of what was received.
   */
  onFired(_now: Date): void {
    if (this.pendingEvents.length === 0) return;

    const count = this.pendingEvents.length;
    const first = this.pendingEvents[0]!;
    const sourceStr = first.source ? ` from ${first.source}` : "";

    const summary = `Webhook received: ${first.action}${sourceStr}. ${count} event(s). Action: ${this.defaultAction}`;

    this._metadata = {
      name: this._metadata.name,
      description: summary,
      type: this._metadata.type,
    };

    // Drain the buffer
    this.pendingEvents.length = 0;
  }

  /**
   * Returns null -- webhook triggers are event-driven, not scheduled.
   */
  getNextRun(): Date | null {
    return null;
  }

  /**
   * Always returns 'active'. Circuit breaker state is managed externally
   * by HeartbeatLoop.
   */
  getState(): TriggerState {
    return "active";
  }

  /**
   * Get a read-only copy of the current pending events buffer.
   */
  getPendingEvents(): ReadonlyArray<WebhookEvent> {
    return [...this.pendingEvents];
  }

  /**
   * Clean up resources: clear pending events.
   */
  async dispose(): Promise<void> {
    this.pendingEvents.length = 0;
  }
}

// =============================================================================
// RATE LIMITER
// =============================================================================

/**
 * Parse a rate limit string like '10/min' or '100/hour' into
 * maxRequests and windowMs.
 */
export function parseRateLimit(rateStr: string): {
  maxRequests: number;
  windowMs: number;
} {
  const match = rateStr.match(/^(\d+)\/(min|hour|sec)$/);
  if (!match) {
    return { maxRequests: 10, windowMs: 60_000 }; // default 10/min
  }

  const maxRequests = parseInt(match[1]!, 10);
  const unit = match[2]!;

  let windowMs: number;
  switch (unit) {
    case "sec":
      windowMs = 1_000;
      break;
    case "min":
      windowMs = 60_000;
      break;
    case "hour":
      windowMs = 3_600_000;
      break;
    default:
      windowMs = 60_000;
  }

  return { maxRequests, windowMs };
}

/**
 * Sliding window rate limiter for the webhook endpoint.
 * Tracks timestamps of allowed requests and rejects when the window is full.
 */
export class WebhookRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed at the given timestamp.
   * Returns true if allowed (and records the timestamp), false if rate limited.
   */
  isAllowed(now: number): boolean {
    // Remove timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0]! <= now - this.windowMs) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}

// =============================================================================
// AUTH VALIDATION
// =============================================================================

/**
 * Validate webhook authentication using dual auth strategy:
 * 1. X-Webhook-Secret header matched against configured secret (timing-safe)
 * 2. Authorization: Bearer <token> matched against dashboard token
 *
 * If neither secret nor dashboard token is configured, returns 403 (secure by default).
 */
export function validateWebhookAuth(
  headers: Record<string, string | undefined>,
  webhookSecret: string | undefined,
  dashboardToken: string | undefined,
): { valid: boolean; status?: number; message?: string } {
  const secretHeader = headers["x-webhook-secret"];
  const authHeader = headers["authorization"];

  // 1. Try webhook secret first
  if (webhookSecret && secretHeader) {
    if (timingSafeCompare(secretHeader, webhookSecret)) {
      return { valid: true };
    }
    return { valid: false, status: 401, message: "Invalid webhook secret" };
  }

  // 2. Try dashboard token
  if (dashboardToken && authHeader) {
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;
    if (token === dashboardToken) {
      return { valid: true };
    }
    return { valid: false, status: 401, message: "Invalid authorization token" };
  }

  // 3. No auth configured or no credentials provided
  if (!webhookSecret && !dashboardToken) {
    return {
      valid: false,
      status: 403,
      message: "Webhook authentication not configured",
    };
  }

  return {
    valid: false,
    status: 401,
    message: "Authentication required",
  };
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Handles different-length strings by padding the shorter one.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;

  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");

  // timingSafeEqual requires same length buffers
  if (bufA.length !== bufB.length) {
    // Compare against a same-length dummy to avoid timing leak on length
    const dummy = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, dummy);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}
