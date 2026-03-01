import { getLogger } from "../utils/logger.js";

/**
 * Authentication and authorization for Strata Brain.
 * Controls who can access the bot and what they can do.
 *
 * Path security is handled by `path-guard.ts` — not this class.
 */
export class AuthManager {
  private readonly allowedTelegramIds: Set<number>;

  constructor(
    allowedTelegramIds: number[],
  ) {
    this.allowedTelegramIds = new Set(allowedTelegramIds);
  }

  /**
   * Check if a Telegram user is authorized to use the bot.
   */
  isTelegramUserAllowed(userId: number): boolean {
    const allowed = this.allowedTelegramIds.has(userId);
    if (!allowed) {
      getLogger().warn("Unauthorized access attempt", {
        userId,
        channel: "telegram",
      });
    }
    return allowed;
  }
}
