/**
 * Tests for bootstrap-channels.ts
 *
 * Covers: channel initialization, missing token errors, dashboard startup,
 * rate limiter creation, graceful degradation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../channels/telegram/bot.js", () => ({
  TelegramChannel: vi.fn().mockImplementation(function (...args: unknown[]) {
    return { name: "telegram", _args: args };
  }),
}));

vi.mock("../channels/cli/repl.js", () => ({
  CLIChannel: vi.fn().mockImplementation(function () {
    return { name: "cli" };
  }),
}));

vi.mock("../channels/discord/bot.js", () => ({
  DiscordChannel: vi.fn().mockImplementation(function (...args: unknown[]) {
    return { name: "discord", _args: args };
  }),
}));

vi.mock("../channels/discord/commands.js", () => ({
  getDefaultSlashCommands: vi.fn(() => [{ name: "help" }]),
}));


vi.mock("../channels/web/channel.js", () => ({
  WebChannel: vi.fn().mockImplementation(function (...args: unknown[]) {
    return { name: "web", _args: args };
  }),
}));

vi.mock("../security/auth.js", () => ({
  AuthManager: vi.fn(),
}));

vi.mock("../dashboard/metrics.js", () => ({
  MetricsCollector: vi.fn(),
}));

vi.mock("../dashboard/server.js", () => ({
  DashboardServer: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../security/rate-limiter.js", () => ({
  RateLimiter: vi.fn().mockImplementation(function (opts: unknown) {
    return { _opts: opts };
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { initializeChannel, initializeDashboard, initializeRateLimiter } from "./bootstrap-channels.js";
import type { Config } from "../config/config.js";
import { DashboardServer } from "../dashboard/server.js";
import type * as winston from "winston";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): winston.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as winston.Logger;
}

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    telegram: { botToken: "" },
    discord: { botToken: "", guildId: "" },
    web: { port: 3000 },
    dashboard: { enabled: false, port: 9090 },
    websocketDashboard: { authToken: "secret" },
    memory: { dbPath: "/tmp/memory" },
    teams: {
      appId: "",
      appPassword: "",
      allowOpenAccess: false,
      allowedUserIds: [],
    },
    rateLimit: {
      enabled: false,
      messagesPerMinute: 0,
      messagesPerHour: 0,
      tokensPerDay: 0,
      dailyBudgetUsd: 0,
      monthlyBudgetUsd: 0,
    },
    ...overrides,
  } as unknown as Config;
}

// ---------------------------------------------------------------------------
// Tests: initializeChannel
// ---------------------------------------------------------------------------

describe("initializeChannel", () => {
  const logger = makeLogger();
  const auth = {} as any;

  it("should return a CLIChannel for 'cli'", async () => {
    const channel = await initializeChannel("cli", makeConfig(), auth, logger);
    expect(channel).toBeDefined();
    expect((channel as any).name).toBe("cli");
  });

  it("should return a WebChannel for 'web'", async () => {
    const channel = await initializeChannel("web", makeConfig(), auth, logger);
    expect(channel).toBeDefined();
    expect((channel as any).name).toBe("web");
  });




  // --- Missing token errors ---

  it("should throw MISSING_DISCORD_TOKEN when discord botToken is missing", async () => {
    const config = makeConfig({ discord: { botToken: "", guildId: "" } });
    await expect(initializeChannel("discord", config, auth)).rejects.toThrow(
      /DISCORD_BOT_TOKEN is required/,
    );
  });

  it("should return a DiscordChannel when discord botToken is provided", async () => {
    const config = makeConfig({ discord: { botToken: "abc123", guildId: "guild1" } });
    const channel = await initializeChannel("discord", config, auth);
    expect(channel).toBeDefined();
    expect((channel as any).name).toBe("discord");
  });

  it("should throw MISSING_TELEGRAM_TOKEN when telegram botToken is missing", async () => {
    const config = makeConfig({ telegram: { botToken: "" } });
    await expect(initializeChannel("telegram", config, auth)).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN is required/,
    );
  });

  it("should return a TelegramChannel when telegram botToken is provided", async () => {
    const config = makeConfig({ telegram: { botToken: "tg-token" } });
    const channel = await initializeChannel("telegram", config, auth);
    expect(channel).toBeDefined();
    expect((channel as any).name).toBe("telegram");
  });

  it("should default to telegram channel for unknown channelType", async () => {
    const config = makeConfig({ telegram: { botToken: "tg-token" } });
    const channel = await initializeChannel("unknown-channel", config, auth);
    expect((channel as any).name).toBe("telegram");
  });
});

// ---------------------------------------------------------------------------
// Tests: initializeDashboard
// ---------------------------------------------------------------------------

describe("initializeDashboard", () => {
  const logger = makeLogger();

  it("should return undefined when dashboard is disabled", async () => {
    const config = makeConfig({ dashboard: { enabled: false, port: 9090 } });
    const result = await initializeDashboard(config, {} as any, undefined, logger);
    expect(result).toBeUndefined();
  });

  it("should return a DashboardServer when dashboard is enabled", async () => {
    const config = makeConfig({ dashboard: { enabled: true, port: 9090 } });
    const result = await initializeDashboard(config, {} as any, undefined, logger);
    expect(result).toBeDefined();
  });

  it("should return undefined and log warn when dashboard start fails", async () => {
    vi.mocked(DashboardServer).mockImplementationOnce(function () {
      return {
        start: vi.fn(async () => {
          throw new Error("port in use");
        }),
        stop: vi.fn(async () => {}),
      } as any;
    });

    const config = makeConfig({ dashboard: { enabled: true, port: 9090 } });
    const result = await initializeDashboard(config, {} as any, undefined, logger);

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Dashboard failed to start",
      expect.objectContaining({ error: "port in use" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: initializeRateLimiter
// ---------------------------------------------------------------------------

describe("initializeRateLimiter", () => {
  const logger = makeLogger();

  it("should return undefined when rate limiting is disabled", () => {
    const config = makeConfig({ rateLimit: { enabled: false } });
    const result = initializeRateLimiter(config, logger);
    expect(result).toBeUndefined();
  });

  it("should return a RateLimiter when rate limiting is enabled", () => {
    const config = makeConfig({
      rateLimit: {
        enabled: true,
        messagesPerMinute: 10,
        messagesPerHour: 100,
        tokensPerDay: 50000,
        dailyBudgetUsd: 5,
        monthlyBudgetUsd: 50,
      },
    });
    const result = initializeRateLimiter(config, logger);
    expect(result).toBeDefined();
  });

  it("should log rate limiter initialization details", () => {
    const config = makeConfig({
      rateLimit: {
        enabled: true,
        messagesPerMinute: 10,
        messagesPerHour: 100,
        tokensPerDay: 50000,
        dailyBudgetUsd: 5,
        monthlyBudgetUsd: 50,
      },
    });
    initializeRateLimiter(config, logger);
    expect(logger.info).toHaveBeenCalledWith(
      "Rate limiter initialized",
      expect.objectContaining({
        messagesPerMinute: 10,
        dailyBudgetUsd: 5,
      }),
    );
  });
});
