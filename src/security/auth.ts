import { getLogger } from "../utils/logger.js";
import {
  isAllowedByAnyOfPolicy,
  isAllowedBySingleIdPolicy,
} from "./access-policy.js";

interface AuthOptions {
  allowedSlackIds?: string[];
  allowedSlackWorkspaces?: string[];
  allowedDiscordIds?: Set<string>;
  allowedDiscordRoles?: Set<string>;
}

function warnUnauthorized(channel: string, details: Record<string, unknown>): void {
  getLogger().warn(`Unauthorized ${channel} access attempt`, {
    ...details,
    channel,
  });
}

/**
 * Authentication and authorization for Strada Brain.
 * Controls who can access the bot and what they can do.
 *
 * Path security is handled by `path-guard.ts` — not this class.
 */
export class AuthManager {
  private readonly allowedTelegramIds: Set<number>;
  private readonly allowedSlackIds: Set<string>;
  private readonly allowedSlackWorkspaces: Set<string>;
  private readonly allowedDiscordUserIds: Set<string>;
  private readonly allowedDiscordRoleIds: Set<string>;

  constructor(
    allowedTelegramIds: number[],
    options?: AuthOptions
  ) {
    this.allowedTelegramIds = new Set(allowedTelegramIds);
    this.allowedSlackIds = new Set(options?.allowedSlackIds ?? []);
    this.allowedSlackWorkspaces = new Set(options?.allowedSlackWorkspaces ?? []);
    this.allowedDiscordUserIds = options?.allowedDiscordIds ?? new Set();
    this.allowedDiscordRoleIds = options?.allowedDiscordRoles ?? new Set();
  }

  /**
   * Check if a Telegram user is authorized to use the bot.
   */
  isTelegramUserAllowed(userId: number): boolean {
    const allowed = isAllowedBySingleIdPolicy(userId, this.allowedTelegramIds, "closed");
    if (!allowed) {
      warnUnauthorized("telegram", { userId });
    }
    return allowed;
  }

  /**
   * Check if a Slack user is authorized to use the bot.
   * Default: closed (deny-all when no allowlist configured).
   */
  isSlackUserAllowed(userId: string): boolean {
    const allowed = isAllowedBySingleIdPolicy(userId, this.allowedSlackIds, "closed");
    if (!allowed) {
      warnUnauthorized("slack", { userId });
    }
    return allowed;
  }

  /**
   * Check if a Slack workspace is authorized.
   * Default: closed (deny-all when no allowlist configured).
   */
  isSlackWorkspaceAllowed(workspaceId: string): boolean {
    const allowed = isAllowedBySingleIdPolicy(workspaceId, this.allowedSlackWorkspaces, "closed");
    if (!allowed) {
      warnUnauthorized("slack-workspace", { workspaceId });
    }
    return allowed;
  }

  /**
   * Check combined Slack authorization (user + workspace).
   */
  isSlackAllowed(userId: string, workspaceId?: string): boolean {
    const userAllowed = this.isSlackUserAllowed(userId);
    const workspaceAllowed = workspaceId 
      ? this.isSlackWorkspaceAllowed(workspaceId) 
      : true;

    return userAllowed && workspaceAllowed;
  }

  /**
   * Check if a Discord user is authorized to use the bot.
   */
  isDiscordUserAllowed(userId: string, userRoles?: string[]): boolean {
    const allowed = isAllowedByAnyOfPolicy({
      subjectId: userId,
      subjectAllowlist: this.allowedDiscordUserIds,
      attributes: userRoles ?? [],
      attributeAllowlist: this.allowedDiscordRoleIds,
      emptyAllowlistMode: "closed",
    });
    if (allowed) {
      return true;
    }

    warnUnauthorized("discord", { userId });

    return false;
  }

  /**
   * Check if Discord ID is allowed (convenience method).
   */
  isDiscordIdAllowed(userId: string): boolean {
    return this.allowedDiscordUserIds.has(userId);
  }

  /**
   * Check if user has an allowed Discord role.
   */
  hasAllowedDiscordRole(userRoles: string[]): boolean {
    return isAllowedByAnyOfPolicy({
      subjectId: "",
      subjectAllowlist: [] as string[],
      attributes: userRoles,
      attributeAllowlist: this.allowedDiscordRoleIds,
      emptyAllowlistMode: "closed",
    });
  }

  /**
   * Add a Discord user at runtime.
   */
  addDiscordUser(userId: string): void {
    this.allowedDiscordUserIds.add(userId);
    getLogger().info("Added Discord user", { userId });
  }

  /**
   * Remove a Discord user at runtime.
   */
  removeDiscordUser(userId: string): boolean {
    const removed = this.allowedDiscordUserIds.delete(userId);
    if (removed) {
      getLogger().info("Removed Discord user", { userId });
    }
    return removed;
  }

  /**
   * Add a Discord role at runtime.
   */
  addDiscordRole(roleId: string): void {
    this.allowedDiscordRoleIds.add(roleId);
    getLogger().info("Added Discord role", { roleId });
  }

  /**
   * Remove a Discord role at runtime.
   */
  removeDiscordRole(roleId: string): boolean {
    const removed = this.allowedDiscordRoleIds.delete(roleId);
    if (removed) {
      getLogger().info("Removed Discord role", { roleId });
    }
    return removed;
  }

  /**
   * Get Discord auth status.
   */
  getDiscordAuthStatus(): {
    allowedUserCount: number;
    allowedRoleCount: number;
    hasAnyRestrictions: boolean;
  } {
    return {
      allowedUserCount: this.allowedDiscordUserIds.size,
      allowedRoleCount: this.allowedDiscordRoleIds.size,
      hasAnyRestrictions: this.allowedDiscordUserIds.size > 0 || this.allowedDiscordRoleIds.size > 0,
    };
  }

  /**
   * Get the list of allowed Telegram IDs.
   */
  getAllowedTelegramIds(): number[] {
    return Array.from(this.allowedTelegramIds);
  }

  /**
   * Get the list of allowed Slack user IDs.
   */
  getAllowedSlackIds(): string[] {
    return Array.from(this.allowedSlackIds);
  }

  /**
   * Get the list of allowed Slack workspaces.
   */
  getAllowedSlackWorkspaces(): string[] {
    return Array.from(this.allowedSlackWorkspaces);
  }

  /**
   * Get the list of allowed Discord user IDs.
   */
  getAllowedDiscordUserIds(): string[] {
    return Array.from(this.allowedDiscordUserIds);
  }

  /**
   * Get the list of allowed Discord role IDs.
   */
  getAllowedDiscordRoleIds(): string[] {
    return Array.from(this.allowedDiscordRoleIds);
  }
}
