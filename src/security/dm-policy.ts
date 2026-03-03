/**
 * DM Policy (Diff/Merge Confirmation Flow)
 *
 * Manages confirmation policy for destructive or modifying operations.
 */

import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { FileDiff, BatchDiff } from "../utils/diff-generator.js";
import { formatDiffForChannel, formatBatchDiffForChannel } from "../utils/diff-formatter.js";
import { getLogger } from "../utils/logger.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_FILE_THRESHOLD = 3;
const DEFAULT_LINE_THRESHOLD = 50;
const DEFAULT_PREVIEW_LINES = 50;
const MAX_FULL_DIFF_LINES = 500;

const DESTRUCTIVE_TOOLS = [
  "file_delete",
  "file_delete_directory",
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

export interface ApprovalResult {
  approved: boolean;
  action: "approve" | "reject" | "edit" | "view_full" | "timeout";
  editedContent?: string;
  message?: string;
}

export interface DMPolicyConfig {
  defaultLevel: ApprovalLevel;
  defaultTimeoutMs: number;
  smartFileThreshold: number;
  smartLineThreshold: number;
  maxPreviewLines: number;
  allowEditing: boolean;
}

interface PendingConfirmation {
  id: string;
  chatId: string;
  userId: string;
  requestedAt: Date;
  timeoutMs: number;
  fileDiff?: FileDiff;
  batchDiff?: BatchDiff;
  resolve: (result: ApprovalResult) => void;
  operation: string;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DMPolicyConfig = {
  defaultLevel: ApprovalLevel.SMART,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  smartFileThreshold: DEFAULT_FILE_THRESHOLD,
  smartLineThreshold: DEFAULT_LINE_THRESHOLD,
  maxPreviewLines: DEFAULT_PREVIEW_LINES,
  allowEditing: true,
};

// ─── DMPolicy Class ──────────────────────────────────────────────────────────

export class DMPolicy {
  private readonly config: DMPolicyConfig;
  private readonly channel: IChannelAdapter;
  private readonly sessionPrefs = new Map<string, SessionApprovalPrefs>();
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private confirmationCounter = 0;

  constructor(channel: IChannelAdapter, config: Partial<DMPolicyConfig> = {}) {
    this.channel = channel;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Session Preferences ───────────────────────────────────────────────────

  getSessionPrefs(userId: string, chatId: string): SessionApprovalPrefs {
    const key = `${userId}:${chatId}`;
    let prefs = this.sessionPrefs.get(key);

    if (!prefs || this.isExpired(prefs)) {
      prefs = {
        userId,
        level: this.config.defaultLevel,
        smartFileThreshold: this.config.smartFileThreshold,
        smartLineThreshold: this.config.smartLineThreshold,
      };
      this.sessionPrefs.set(key, prefs);
    }

    return prefs;
  }

  setSessionPrefs(userId: string, chatId: string, prefs: Partial<SessionApprovalPrefs>): void {
    const key = `${userId}:${chatId}`;
    const existing = this.getSessionPrefs(userId, chatId);
    this.sessionPrefs.set(key, { ...existing, ...prefs, userId });
  }

  resetSessionPrefs(userId: string, chatId: string): void {
    this.sessionPrefs.delete(`${userId}:${chatId}`);
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

  // ─── Request Approval ──────────────────────────────────────────────────────

  async requestApproval(
    chatId: string,
    userId: string,
    diff: FileDiff | BatchDiff,
    operation: string,
    isDestructive = false,
  ): Promise<ApprovalResult> {
    const prefs = this.getSessionPrefs(userId, chatId);

    if (!this.isApprovalRequired(prefs, diff, isDestructive)) {
      return { approved: true, action: "approve", message: "Auto-approved by policy" };
    }

    const channelType = this.detectChannelType(chatId);
    const isBatch = "files" in diff;

    const preview = isBatch
      ? formatBatchDiffForChannel(diff, channelType, { maxLines: this.config.maxPreviewLines })
      : formatDiffForChannel(diff, channelType, { maxLines: this.config.maxPreviewLines });

    return this.createConfirmation(
      chatId,
      userId,
      diff,
      operation,
      preview,
      channelType,
      isDestructive,
    );
  }

  private createConfirmation(
    chatId: string,
    userId: string,
    diff: FileDiff | BatchDiff,
    operation: string,
    preview: string,
    channelType: "telegram" | "whatsapp" | "cli",
    isDestructive: boolean,
  ): Promise<ApprovalResult> {
    const confirmationId = this.generateConfirmationId();

    return new Promise<ApprovalResult>((resolve) => {
      const confirmation: PendingConfirmation = {
        id: confirmationId,
        chatId,
        userId,
        requestedAt: new Date(),
        timeoutMs: this.config.defaultTimeoutMs,
        ...("files" in diff ? { batchDiff: diff } : { fileDiff: diff }),
        resolve,
        operation,
      };

      this.pendingConfirmations.set(confirmationId, confirmation);

      this.sendConfirmationRequest(confirmation, preview, channelType, isDestructive).catch(
        (err) => {
          getLogger().error("Failed to send confirmation request", { error: err });
          resolve({ approved: false, action: "timeout", message: "Failed to send confirmation" });
        },
      );

      setTimeout(() => this.handleTimeout(confirmationId), this.config.defaultTimeoutMs);
    });
  }

  // ─── Handle User Response ──────────────────────────────────────────────────

  handleUserResponse(confirmationId: string, response: string): boolean {
    const confirmation = this.pendingConfirmations.get(confirmationId);
    if (!confirmation) return false;

    const action = this.parseUserResponse(response);

    switch (action) {
      case "approve":
        this.resolveConfirmation(confirmationId, { approved: true, action: "approve" });
        return true;

      case "reject":
        this.resolveConfirmation(confirmationId, {
          approved: false,
          action: "reject",
          message: "User rejected",
        });
        return true;

      case "view_full":
        this.sendFullDiff(confirmation);
        return true;

      case "edit":
        this.handleEditRequest(confirmation);
        return true;

      default:
        this.channel
          .sendText(
            confirmation.chatId,
            "Please respond with: ✅ Approve, ❌ Reject, or 📋 View Full",
          )
          .catch((err) =>
            getLogger().error("Failed to send approval prompt", {
              chatId: confirmation.chatId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return true;
    }
  }

  cancelConfirmation(confirmationId: string, reason = "Cancelled"): boolean {
    const confirmation = this.pendingConfirmations.get(confirmationId);
    if (!confirmation) return false;

    this.resolveConfirmation(confirmationId, {
      approved: false,
      action: "timeout",
      message: reason,
    });
    return true;
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  getPendingConfirmations(): Array<{
    id: string;
    chatId: string;
    userId: string;
    requestedAt: Date;
    operation: string;
  }> {
    return Array.from(this.pendingConfirmations.values()).map((c) => ({
      id: c.id,
      chatId: c.chatId,
      userId: c.userId,
      requestedAt: c.requestedAt,
      operation: c.operation,
    }));
  }

  cleanupExpiredPrefs(): void {
    const now = new Date();
    for (const [key, prefs] of this.sessionPrefs.entries()) {
      if (prefs.expiresAt && prefs.expiresAt < now) {
        this.sessionPrefs.delete(key);
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private isExpired(prefs: SessionApprovalPrefs): boolean {
    return prefs.expiresAt !== undefined && prefs.expiresAt < new Date();
  }

  private generateConfirmationId(): string {
    return `dm_${Date.now()}_${++this.confirmationCounter}`;
  }

  private detectChannelType(chatId: string): "telegram" | "whatsapp" | "cli" {
    if (chatId.startsWith("telegram_") || /^\d+$/.test(chatId)) return "telegram";
    if (chatId.startsWith("whatsapp_")) return "whatsapp";
    return "cli";
  }

  private async sendConfirmationRequest(
    confirmation: PendingConfirmation,
    preview: string,
    channelType: "telegram" | "whatsapp" | "cli",
    isDestructive: boolean,
  ): Promise<void> {
    const warning = isDestructive ? "⚠️ " : "";
    const header = `${warning}*Approval Required*\n\n`;
    const footer = "\n\n_Reply with: ✅ Approve, ❌ Reject, or 📋 View Full_";

    const message =
      channelType === "cli"
        ? `${preview}\n\nApprove? (y/n/v for view full): `
        : header + preview + footer;

    await this.channel.sendMarkdown(confirmation.chatId, message);
  }

  private parseUserResponse(
    response: string,
  ): "approve" | "reject" | "edit" | "view_full" | "unknown" {
    const lower = response.toLowerCase().trim();

    if (/^(yes|y|approve|✅|✓|ok|confirm)/i.test(lower)) return "approve";
    if (/^(no|n|reject|❌|✗|cancel|deny|stop)/i.test(lower)) return "reject";
    if (/^(view|full|more|details|📋|show)/i.test(lower)) return "view_full";
    if (/^(edit|modify|change|✏️)/i.test(lower)) return "edit";

    return "unknown";
  }

  private async sendFullDiff(confirmation: PendingConfirmation): Promise<void> {
    const channelType = this.detectChannelType(confirmation.chatId);

    const fullDiff = confirmation.fileDiff
      ? formatDiffForChannel(confirmation.fileDiff, channelType, { maxLines: MAX_FULL_DIFF_LINES })
      : confirmation.batchDiff
        ? formatBatchDiffForChannel(confirmation.batchDiff, channelType, {
            maxLines: MAX_FULL_DIFF_LINES,
          })
        : "No diff available";

    await this.channel.sendMarkdown(
      confirmation.chatId,
      `*Full Diff:*\n\n${fullDiff}\n\n_Reply with: ✅ Approve or ❌ Reject_`,
    );
  }

  private handleEditRequest(confirmation: PendingConfirmation): void {
    if (!this.config.allowEditing || !confirmation.fileDiff) {
      this.channel
        .sendText(confirmation.chatId, "Editing is not available for this operation.")
        .catch((err) =>
          getLogger().error("Failed to send editing unavailable message", {
            chatId: confirmation.chatId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return;
    }

    this.channel
      .sendText(
        confirmation.chatId,
        "Please send the edited content. Reply with 'cancel' to abort.",
      )
      .catch((err) =>
        getLogger().error("Failed to send edit prompt", {
          chatId: confirmation.chatId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    getLogger().info("Edit requested for confirmation", {
      confirmationId: confirmation.id,
      operation: confirmation.operation,
    });
  }

  private resolveConfirmation(confirmationId: string, result: ApprovalResult): void {
    const confirmation = this.pendingConfirmations.get(confirmationId);
    if (!confirmation) return;

    this.pendingConfirmations.delete(confirmationId);
    confirmation.resolve(result);
  }

  private handleTimeout(confirmationId: string): void {
    if (!this.pendingConfirmations.has(confirmationId)) return;

    this.resolveConfirmation(confirmationId, {
      approved: false,
      action: "timeout",
      message: "Confirmation timed out",
    });
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
  if (!DESTRUCTIVE_TOOLS.includes(toolName)) return false;

  if (toolName === "shell_exec") {
    const command = String(input["command"] || "").toLowerCase();
    const dangerous = ["rm ", "del ", "rmdir", "format", "mkfs", ">", "dd ", "shutdown", "reboot"];
    return dangerous.some((p) => command.includes(p));
  }

  return true;
}
