/**
 * Bootstrap — Channel and dashboard initialization helpers
 *
 * Extracted from bootstrap.ts to reduce file size.
 * Contains channel setup, dashboard initialization, and rate limiter creation.
 */

import { join } from "node:path";
import type { Config } from "../config/config.js";
import { AuthManager } from "../security/auth.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { DashboardServer } from "../dashboard/server.js";
import { RateLimiter } from "../security/rate-limiter.js";
import { AppError } from "../common/errors.js";
import { DEFAULT_RATE_LIMITS } from "../common/constants.js";

// Channel imports
import { TelegramChannel } from "../channels/telegram/bot.js";
import { CLIChannel } from "../channels/cli/repl.js";
import { DiscordChannel } from "../channels/discord/bot.js";
import { getDefaultSlashCommands } from "../channels/discord/commands.js";
import { WhatsAppChannel } from "../channels/whatsapp/client.js";
import { WebChannel } from "../channels/web/channel.js";

import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type * as winston from "winston";

export async function initializeChannel(
  channelType: string,
  config: Config,
  auth: AuthManager,
  logger: winston.Logger,
): Promise<IChannelAdapter> {
  switch (channelType) {
    case "cli":
      return new CLIChannel();

    case "whatsapp": {
      const sessionPath = config.whatsapp.sessionPath;
      const allowedNumbers = config.whatsapp.allowedNumbers;
      if (allowedNumbers.length === 0) {
        logger.info("WHATSAPP_ALLOWED_NUMBERS is empty — WhatsApp is open to all senders");
      }
      return new WhatsAppChannel(sessionPath, allowedNumbers);
    }

    case "discord": {
      if (!config.discord.botToken) {
        throw new AppError(
          "DISCORD_BOT_TOKEN is required when using Discord channel",
          "MISSING_DISCORD_TOKEN",
        );
      }
      return new DiscordChannel(config.discord.botToken, auth, {
        guildId: config.discord.guildId,
        slashCommands: getDefaultSlashCommands(),
      });
    }

    case "web":
      return new WebChannel(config.web.port, config.dashboard.port, {
        dashboardAuthToken: config.websocketDashboard.authToken,
        identityDbPath: join(config.memory.dbPath, "web-identities.db"),
      });

    case "matrix": {
      const { MatrixChannel } = await import("../channels/matrix/channel.js");
      const homeserver = config.matrix.homeserver;
      const accessToken = config.matrix.accessToken;
      const matrixUserId = config.matrix.userId;
      const allowOpenAccess = config.matrix.allowOpenAccess;
      const allowedUserIds = config.matrix.allowedUserIds;
      const allowedRoomIds = config.matrix.allowedRoomIds;
      if (!homeserver || !accessToken || !matrixUserId) {
        throw new AppError(
          "MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID are required for Matrix channel",
          "MISSING_MATRIX_CONFIG",
        );
      }
      return new MatrixChannel(
        homeserver,
        accessToken,
        matrixUserId,
        allowedUserIds,
        allowedRoomIds,
        allowOpenAccess,
      );
    }

    case "irc": {
      const { IRCChannel } = await import("../channels/irc/channel.js");
      const ircServer = config.irc.server;
      const ircNick = config.irc.nick;
      const allowOpenAccess = config.irc.allowOpenAccess;
      const ircChannels = config.irc.channels;
      const allowedUsers = config.irc.allowedUsers;
      if (!ircServer) {
        throw new AppError("IRC_SERVER is required for IRC channel", "MISSING_IRC_CONFIG");
      }
      return new IRCChannel(ircServer, ircNick, ircChannels, allowedUsers, allowOpenAccess);
    }

    case "teams": {
      const { TeamsChannel } = await import("../channels/teams/channel.js");
      const teamsAppId = config.teams.appId;
      const teamsAppPassword = config.teams.appPassword;
      const allowOpenAccess = config.teams.allowOpenAccess;
      const allowedUserIds = config.teams.allowedUserIds;
      if (!teamsAppId || !teamsAppPassword) {
        throw new AppError(
          "TEAMS_APP_ID and TEAMS_APP_PASSWORD are required for Teams channel",
          "MISSING_TEAMS_CONFIG",
        );
      }
      return new TeamsChannel(
        teamsAppId,
        teamsAppPassword,
        3978,
        allowedUserIds,
        "127.0.0.1",
        allowOpenAccess,
      );
    }

    case "telegram":
    default: {
      if (!config.telegram.botToken) {
        throw new AppError(
          "TELEGRAM_BOT_TOKEN is required when using Telegram channel",
          "MISSING_TELEGRAM_TOKEN",
        );
      }
      return new TelegramChannel(config.telegram.botToken, auth);
    }
  }
}

export async function initializeDashboard(
  config: Config,
  metrics: MetricsCollector,
  memoryManager: IMemoryManager | undefined,
  logger: winston.Logger,
): Promise<DashboardServer | undefined> {
  if (!config.dashboard.enabled) {
    return undefined;
  }

  const dashboard = new DashboardServer(config.dashboard.port, metrics, () =>
    memoryManager?.getStats(),
  );

  try {
    await dashboard.start();
    return dashboard;
  } catch (error) {
    logger.warn("Dashboard failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function initializeRateLimiter(config: Config, logger: winston.Logger): RateLimiter | undefined {
  if (!config.rateLimit.enabled) {
    return undefined;
  }

  const rateLimiter = new RateLimiter({
    messagesPerMinute: config.rateLimit.messagesPerMinute || DEFAULT_RATE_LIMITS.messagesPerMinute,
    messagesPerHour: config.rateLimit.messagesPerHour || DEFAULT_RATE_LIMITS.messagesPerHour,
    tokensPerDay: config.rateLimit.tokensPerDay || DEFAULT_RATE_LIMITS.tokensPerDay,
    dailyBudgetUsd: config.rateLimit.dailyBudgetUsd || DEFAULT_RATE_LIMITS.dailyBudgetUsd,
    monthlyBudgetUsd: config.rateLimit.monthlyBudgetUsd || DEFAULT_RATE_LIMITS.monthlyBudgetUsd,
  });

  logger.info("Rate limiter initialized", {
    messagesPerMinute: config.rateLimit.messagesPerMinute,
    dailyBudgetUsd: config.rateLimit.dailyBudgetUsd,
  });

  return rateLimiter;
}
