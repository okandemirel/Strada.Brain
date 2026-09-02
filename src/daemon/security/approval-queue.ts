/**
 * ApprovalQueue
 *
 * Manages write-operation approval requests for daemon-initiated tool calls.
 * Persisted in SQLite via DaemonStorage. Supports configurable timeout with
 * auto-expiry (denied on timeout per user decision).
 *
 * Emits daemon events for real-time notification to dashboard/chat channels.
 *
 * Requirements: SEC-04 (Write approval queue)
 */

import { randomUUID } from "node:crypto";
import type { DaemonStorage } from "../daemon-storage.js";
import type { ApprovalEntry, ApprovalStatus, AuditEntry } from "../daemon-types.js";
import type { IEventBus } from "../../core/event-bus.js";
import type { DaemonEventMap } from "../daemon-events.js";

/**
 * Outcome of approve()/deny(). `applied: false` means the decision did NOT
 * land, and `status` names why: the entry's current status ("expired",
 * "denied", "approved") or "missing".
 */
export interface ApprovalDecisionResult {
  readonly applied: boolean;
  readonly status: ApprovalStatus | "missing";
}

export class ApprovalQueue {
  private readonly storage: DaemonStorage;
  private readonly timeoutMinutes: number;
  private readonly eventBus?: IEventBus<DaemonEventMap>;

  constructor(
    storage: DaemonStorage,
    timeoutMinutes: number,
    eventBus?: IEventBus<DaemonEventMap>,
  ) {
    this.storage = storage;
    this.timeoutMinutes = timeoutMinutes;
    this.eventBus = eventBus;
  }

  /**
   * Enqueue a tool execution request for approval.
   * Creates a pending entry with an expiration based on the configured timeout.
   */
  enqueue(
    toolName: string,
    params: Record<string, unknown>,
    triggerName?: string,
  ): ApprovalEntry {
    const now = Date.now();
    const entry: ApprovalEntry = {
      id: randomUUID(),
      toolName,
      params,
      triggerName,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.timeoutMinutes * 60 * 1000,
    };

    this.storage.insertApproval(entry);

    this.eventBus?.emit("daemon:approval_requested", {
      approvalId: entry.id,
      toolName,
      triggerName,
      timestamp: now,
    });

    return entry;
  }

  /**
   * Approve a pending request. Returns whether the decision landed.
   */
  approve(id: string, decidedBy?: string): ApprovalDecisionResult {
    return this.decide(id, "approved", decidedBy);
  }

  /**
   * Deny a pending request. Returns whether the decision landed.
   */
  deny(id: string, decidedBy?: string): ApprovalDecisionResult {
    return this.decide(id, "denied", decidedBy);
  }

  /**
   * Expire all stale pending entries that have passed their timeout.
   * Expired entries are auto-denied per user decision.
   */
  expireStale(): void {
    const now = Date.now();
    const expired = this.storage.getExpiredApprovals(now);

    for (const entry of expired) {
      this.storage.updateApprovalDecision(entry.id, "expired");
      this.storage.insertAuditEntry({
        toolName: entry.toolName,
        paramsSummary: this.summarizeParams(entry.params),
        decision: "expired",
        triggerName: entry.triggerName,
        timestamp: now,
      });
    }

    // Prune resolved entries older than 7 days to prevent unbounded table growth
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    this.storage.pruneOldApprovals(sevenDaysAgo);
  }

  /**
   * Get all pending approval entries.
   */
  getPending(): ApprovalEntry[] {
    return this.storage.getPending();
  }

  /**
   * Get a specific approval entry by ID.
   */
  getById(id: string): ApprovalEntry | undefined {
    return this.storage.getApprovalById(id);
  }

  /**
   * Get recent audit log entries.
   */
  getAuditLog(limit?: number): AuditEntry[] {
    return this.storage.getRecentAudit(limit);
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private decide(id: string, decision: "approved" | "denied", decidedBy?: string): ApprovalDecisionResult {
    const entry = this.storage.getApprovalById(id);
    if (!entry) return { applied: false, status: "missing" };

    // Audited 2026-09-02: there was no status guard and the UPDATE has no
    // `WHERE status='pending'`, so an entry expireStale() had already
    // auto-denied (SEC-04 "denied on timeout") — or one a human had denied —
    // could be flipped to "approved" hours later and drive the deploy bridge
    // into executor.execute(). A decision only lands on a live request.
    if (entry.status !== "pending") {
      return { applied: false, status: entry.status };
    }

    this.storage.updateApprovalDecision(id, decision, decidedBy);
    this.storage.insertAuditEntry({
      toolName: entry.toolName,
      paramsSummary: this.summarizeParams(entry.params),
      decision,
      decidedBy,
      triggerName: entry.triggerName,
      timestamp: Date.now(),
    });

    this.eventBus?.emit("daemon:approval_decided", {
      approvalId: id,
      decision,
      decidedBy,
      timestamp: Date.now(),
    });

    return { applied: true, status: decision };
  }

  private summarizeParams(params: Record<string, unknown>): string {
    const json = JSON.stringify(params);
    return json.length > 200 ? json.slice(0, 197) + "..." : json;
  }
}
