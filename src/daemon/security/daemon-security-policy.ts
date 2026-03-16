/**
 * DaemonSecurityPolicy
 *
 * Middleware that enforces the read-only-by-default security contract for
 * daemon-initiated tool calls. Classifies tools as 'allow' or 'queue' based
 * on their readOnly metadata, an auto-approve allowlist, and a hardcoded
 * file-write tool set that always requires approval.
 *
 * This class does NOT execute tools directly. The HeartbeatLoop calls
 * checkPermission() before executing, and if 'queue', calls requestApproval()
 * and skips execution until approved.
 *
 * Requirements: SEC-03 (Read-only default), SEC-04 (Write approval)
 */

import type { ApprovalQueue } from "./approval-queue.js";
import type { ApprovalEntry } from "../daemon-types.js";

/** Metadata lookup function -- decoupled from ToolRegistry for testability */
export type MetadataLookup = (
  name: string,
) => { readOnly: boolean } | undefined;

/** Permission result from security policy check */
export type PermissionResult = "allow" | "queue";

export class DaemonSecurityPolicy {
  private readonly metadataLookup: MetadataLookup;
  private readonly approvalQueue: ApprovalQueue;
  private readonly autoApproveList: Set<string>;
  private autonomousOverride = false;
  private autonomousExpiresAt?: number;

  /** Dangerous tools that always require approval, even if auto-approved */
  private static readonly ALWAYS_QUEUE_TOOLS = new Set([
    "file_write",
    "file_create",
    "file_edit",
    "file_delete",
    "file_rename",
    "file_delete_directory",
    "shell_exec",
    "git_commit",
    "git_push",
    "git_stash",
  ]);

  constructor(
    metadataLookup: MetadataLookup,
    approvalQueue: ApprovalQueue,
    autoApproveList: Set<string>,
  ) {
    this.metadataLookup = metadataLookup;
    this.approvalQueue = approvalQueue;
    this.autoApproveList = autoApproveList;
  }

  /**
   * Enable or disable autonomous override.
   * When enabled, all tools are allowed immediately (bypasses ALWAYS_QUEUE_TOOLS).
   * Expiry ensures override auto-reverts even if /autonomous off is never called.
   */
  setAutonomousOverride(enabled: boolean, expiresAt?: number): void {
    this.autonomousOverride = enabled;
    this.autonomousExpiresAt = enabled ? expiresAt : undefined;
  }

  /**
   * Check whether a tool should be allowed to execute immediately or
   * queued for human approval.
   *
   * Decision logic:
   * 1. File-write tools (file_write, file_create, file_edit) -> always 'queue'
   * 2. Unknown tools (not in registry) -> 'queue' (safe default)
   * 3. Read-only tools (metadata.readOnly = true) -> 'allow'
   * 4. Auto-approved tools (in allowlist) -> 'allow'
   * 5. Everything else -> 'queue'
   */
  checkPermission(toolName: string): PermissionResult {
    // Autonomous override: skip all permission checks when user has granted full autonomy
    if (this.autonomousOverride) {
      // Auto-revoke if expiry has passed
      if (this.autonomousExpiresAt !== undefined && this.autonomousExpiresAt <= Date.now()) {
        this.autonomousOverride = false;
        this.autonomousExpiresAt = undefined;
      } else {
        return "allow";
      }
    }

    // File-write tools always require approval, even if auto-approved
    if (DaemonSecurityPolicy.ALWAYS_QUEUE_TOOLS.has(toolName)) {
      return "queue";
    }

    // Get metadata -- unknown tools default to 'queue' (safe default)
    const metadata = this.metadataLookup(toolName);
    if (!metadata) {
      return "queue";
    }

    // Read-only tools execute immediately
    if (metadata.readOnly) {
      return "allow";
    }

    // Auto-approved tools execute immediately (budget still checked separately)
    if (this.autoApproveList.has(toolName)) {
      return "allow";
    }

    // Write tool not auto-approved -- queue for approval
    return "queue";
  }

  /**
   * Request approval for a tool execution.
   * Returns the approval entry for tracking.
   */
  requestApproval(
    toolName: string,
    params: Record<string, unknown>,
    triggerName?: string,
  ): ApprovalEntry {
    return this.approvalQueue.enqueue(toolName, params, triggerName);
  }
}
