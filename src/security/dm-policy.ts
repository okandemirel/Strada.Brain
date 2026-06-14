/**
 * DM Policy (approval policy for destructive or modifying operations)
 *
 * Determines whether an operation requires user confirmation. The live
 * confirmation prompt itself is delivered by the channel adapter via
 * `channel.requestConfirmation` (see orchestrator-write-gate.ts); this module
 * only decides whether approval is required and tracks per-session prefs.
 */

import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { FileDiff, BatchDiff } from "../utils/diff-generator.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_FILE_THRESHOLD = 3;
const DEFAULT_LINE_THRESHOLD = 50;

const DESTRUCTIVE_TOOLS = [
  "file_delete",
  "file_delete_directory",
  "file_rename",
  "file_write",
  "shell_exec",
  "git_push",
  "git_reset",
];

// ─── Types ───────────────────────────────────────────────────────────────────

export enum ApprovalLevel {
  ALWAYS = "always",
  DESTRUCTIVE_ONLY = "destructive_only",
  SMART = "smart",
  NEVER = "never",
}

export interface SessionApprovalPrefs {
  userId: string;
  level: ApprovalLevel;
  smartFileThreshold: number;
  smartLineThreshold: number;
  expiresAt?: Date;
}

export interface DMPolicyConfig {
  defaultLevel: ApprovalLevel;
  smartFileThreshold: number;
  smartLineThreshold: number;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DMPolicyConfig = {
  defaultLevel: ApprovalLevel.SMART,
  smartFileThreshold: DEFAULT_FILE_THRESHOLD,
  smartLineThreshold: DEFAULT_LINE_THRESHOLD,
};

// ─── DMPolicy Class ──────────────────────────────────────────────────────────

export class DMPolicy {
  private readonly config: DMPolicyConfig;
  private readonly sessionPrefs = new Map<string, SessionApprovalPrefs>();
  private readonly autonomousExpiry = new Map<string, number>();

  constructor(_channel: IChannelAdapter, config: Partial<DMPolicyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getPrimarySessionKey(userId: string, chatId: string): string {
    return `${userId}:${chatId}`;
  }

  private getFallbackSessionKey(userId: string, chatId: string): string | null {
    return userId === chatId ? null : `${chatId}:${chatId}`;
  }

  private resolveStoredSessionKey(userId: string, chatId: string): string {
    const primaryKey = this.getPrimarySessionKey(userId, chatId);
    if (this.sessionPrefs.has(primaryKey)) {
      return primaryKey;
    }

    const fallbackKey = this.getFallbackSessionKey(userId, chatId);
    if (fallbackKey && this.sessionPrefs.has(fallbackKey)) {
      return fallbackKey;
    }

    return primaryKey;
  }

  // ─── Session Preferences ───────────────────────────────────────────────────

  getSessionPrefs(userId: string, chatId: string): SessionApprovalPrefs {
    const primaryKey = this.getPrimarySessionKey(userId, chatId);
    const resolvedKey = this.resolveStoredSessionKey(userId, chatId);
    let prefs = this.sessionPrefs.get(resolvedKey);

    if (!prefs || this.isExpired(prefs)) {
      // Do NOT persist the synthetic default on read. Persisting it grew
      // sessionPrefs unbounded across ephemeral chats: defaults carry no
      // expiresAt, so cleanupExpiredPrefs could never reclaim them. Callers
      // (orchestrator user_confirm) only read this value; setSessionPrefs is
      // the sole writer of persisted prefs.
      return this.buildPrefs(userId, this.config.defaultLevel);
    }

    if (resolvedKey !== primaryKey) {
      // Promote the chat-scoped fallback entry to the user-specific primary key.
      // MOVE (not copy): leaving the fallback entries behind duplicated both
      // sessionPrefs and autonomousExpiry under two keys, leaking the stale pair.
      const copied = { ...prefs, userId };
      this.sessionPrefs.set(primaryKey, copied);
      this.sessionPrefs.delete(resolvedKey);
      const expiry = this.autonomousExpiry.get(resolvedKey);
      if (expiry !== undefined) {
        this.autonomousExpiry.set(primaryKey, expiry);
        this.autonomousExpiry.delete(resolvedKey);
      }
      return copied;
    }

    return prefs;
  }

  setSessionPrefs(userId: string, chatId: string, prefs: Partial<SessionApprovalPrefs>): void {
    const key = `${userId}:${chatId}`;
    const existing = this.getSessionPrefs(userId, chatId);
    this.sessionPrefs.set(key, { ...existing, ...prefs, userId });
  }

  resetSessionPrefs(userId: string, chatId: string): void {
    const key = `${userId}:${chatId}`;
    this.sessionPrefs.delete(key);
    // Also drop any tracked autonomous expiry for this key, otherwise it would
    // persist forever after the session pref is gone (unbounded leak).
    this.autonomousExpiry.delete(key);
  }

  // ─── Autonomous Profile Init ────────────────────────────────────────────────

  initFromProfile(
    chatId: string,
    preferences: { autonomousMode?: boolean; autonomousExpiresAt?: number },
    userId?: string,
  ): boolean {
    const key = `${userId ?? chatId}:${chatId}`;
    if (preferences.autonomousMode) {
      // If expiry is set and already passed, don't enable
      if (
        preferences.autonomousExpiresAt !== undefined &&
        preferences.autonomousExpiresAt <= Date.now()
      ) {
        return false;
      }

      this.sessionPrefs.set(key, this.buildPrefs(userId ?? chatId, ApprovalLevel.NEVER));

      // Track expiry if provided
      if (preferences.autonomousExpiresAt !== undefined) {
        this.autonomousExpiry.set(key, preferences.autonomousExpiresAt);
      }

      return true;
    }

    this.sessionPrefs.set(key, this.buildPrefs(userId ?? chatId, ApprovalLevel.SMART));
    this.autonomousExpiry.delete(key);
    return false;
  }

  isAutonomousActive(chatId: string, userId?: string): boolean {
    const resolvedUserId = userId ?? chatId;
    const key = this.resolveStoredSessionKey(resolvedUserId, chatId);
    const prefs = this.sessionPrefs.get(key);
    if (!prefs || prefs.level !== ApprovalLevel.NEVER) {
      return false;
    }

    const expiry = this.autonomousExpiry.get(key);
    if (expiry !== undefined && expiry <= Date.now()) {
      this.sessionPrefs.set(key, this.buildPrefs(userId ?? chatId, ApprovalLevel.SMART));
      this.autonomousExpiry.delete(key);
      return false;
    }

    return true;
  }

  // ─── Approval Logic ────────────────────────────────────────────────────────

  isApprovalRequired(
    prefs: SessionApprovalPrefs,
    diff: FileDiff | BatchDiff,
    isDestructive: boolean,
  ): boolean {
    switch (prefs.level) {
      case ApprovalLevel.NEVER:
        return false;
      case ApprovalLevel.ALWAYS:
        return true;
      case ApprovalLevel.DESTRUCTIVE_ONLY:
        return isDestructive;
      case ApprovalLevel.SMART:
        return isDestructive || this.exceedsThreshold(prefs, diff);
    }
  }

  private exceedsThreshold(prefs: SessionApprovalPrefs, diff: FileDiff | BatchDiff): boolean {
    if ("files" in diff) {
      return (
        diff.files.length >= prefs.smartFileThreshold ||
        diff.totalStats.totalChanges >= prefs.smartLineThreshold
      );
    }
    return diff.stats.totalChanges >= prefs.smartLineThreshold;
  }

  cleanupExpiredPrefs(): void {
    const now = new Date();
    for (const [key, prefs] of this.sessionPrefs.entries()) {
      if (prefs.expiresAt && prefs.expiresAt < now) {
        this.sessionPrefs.delete(key);
        // Keep autonomousExpiry in lockstep with sessionPrefs so it can't leak.
        this.autonomousExpiry.delete(key);
      }
    }
    // Reclaim any orphaned expiry whose session pref is already gone.
    for (const key of this.autonomousExpiry.keys()) {
      if (!this.sessionPrefs.has(key)) {
        this.autonomousExpiry.delete(key);
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /** Build a SessionApprovalPrefs with config defaults for the given level. */
  private buildPrefs(userId: string, level: ApprovalLevel): SessionApprovalPrefs {
    return {
      userId,
      level,
      smartFileThreshold: this.config.smartFileThreshold,
      smartLineThreshold: this.config.smartLineThreshold,
    };
  }


  private isExpired(prefs: SessionApprovalPrefs): boolean {
    return prefs.expiresAt !== undefined && prefs.expiresAt < new Date();
  }
}

// ─── Factory & Utilities ─────────────────────────────────────────────────────

export function createDMPolicy(
  channel: IChannelAdapter,
  config?: Partial<DMPolicyConfig>,
): DMPolicy {
  return new DMPolicy(channel, config);
}

export function isDestructiveOperation(toolName: string, input: Record<string, unknown>): boolean {
  const baseName = toolName.includes(":") ? toolName.split(":").pop()! : toolName;
  if (!DESTRUCTIVE_TOOLS.includes(baseName)) return false;

  if (toolName === "shell_exec") {
    const command = String(input["command"] || "").toLowerCase();
    const dangerous = [
      "rm ", "del ", "rmdir", "format", "mkfs", "dd ",
      "shutdown", "reboot", "truncate ", "shred ", "chmod 777",
    ];
    if (dangerous.some((p) => command.includes(p))) return true;
    // Detect piped remote execution and subshell injection
    const dangerousPatterns = [
      /(?:curl|wget|fetch)\s.*\|\s*(ba)?sh/,     // Pipe-to-shell
      /\$\s*\(/,                                   // Subshell injection (with optional whitespace)
      /`[^`]+`/,                                   // Backtick command substitution
      /\|\s*(?:ba)?sh\b/,                          // Any pipe to sh/bash
      /python[23]?\s+-c\s/,                        // Python one-liner execution
      /node\s+-e\s/,                               // Node.js one-liner execution
      />\s*\/etc\//,                               // Redirect to /etc/
      />\s*\/(?:dev|proc|sys|boot|root|var|home)\//,  // Redirect to system/user directories
      />\s*~\//,                                     // Redirect to home directory
      />\s*\.\.\//,                                  // Redirect via path traversal
    ];
    return dangerousPatterns.some((p) => p.test(command));
  }

  return true;
}
