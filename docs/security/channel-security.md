# Channel Security

This document describes security considerations and controls for Telegram, WhatsApp, Discord, and Slack channels in Strata Brain.

## Table of Contents

- [Overview](#overview)
- [Telegram Security](#telegram-security)
- [Discord Security](#discord-security)
- [Slack Security](#slack-security)
- [WhatsApp Security](#whatsapp-security)
- [Common Security Features](#common-security-features)
- [Best Practices](#best-practices)

## Overview

Strata Brain supports multiple messaging channels, each with its own security model and considerations. This document covers security best practices and implementation details for each channel.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Channel Security Model                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Telegram   │  │   Discord   │  │    Slack    │  │  WhatsApp   │    │
│  │             │  │             │  │             │  │             │    │
│  │ • Bot Token │  │ • Bot Token │  │ • Bot Token │  │ • QR Code   │    │
│  │ • User ID   │  │ • User ID   │  │ • Sign Secret│ │ • Session   │    │
│  │   Whitelist │  │ • Role-based│  │ • Workspace │  │ • Number    │    │
│  │             │  │   Access    │  │   Whitelist │  │   Whitelist │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │           │
│         └────────────────┴────────────────┘                │           │
│                          │                                 │           │
│                          ▼                                 ▼           │
│               ┌─────────────────────┐          ┌──────────────────┐    │
│               │   AuthManager       │          │ Allowed Numbers  │    │
│               │   (Unified Auth)    │          │ (Built-in Auth)  │    │
│               └─────────────────────┘          └──────────────────┘    │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## Telegram Security

### Authentication Model

Telegram uses a simple but effective authentication model:

1. **Bot Token**: Authenticates the bot with Telegram's servers
2. **User ID Whitelist**: Only explicitly allowed users can interact
3. **Immutable IDs**: Telegram user IDs cannot be changed or spoofed

### Security Controls

```typescript
// src/channels/telegram/bot.ts
private setupMiddleware(): void {
  // Auth middleware - block unauthorized users
  this.bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!this.auth.isTelegramUserAllowed(userId)) {
      await ctx.reply(
        "You are not authorized to use Strata Brain. Contact the administrator."
      );
      return;
    }

    await next();
  });
}
```

### Configuration

```bash
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
ALLOWED_TELEGRAM_USER_IDS=123456789,987654321
```

### Security Considerations

| Aspect | Security Level | Notes |
|--------|---------------|-------|
| Transport | High | TLS 1.2+ required |
| Authentication | High | Immutable user IDs |
| Message Privacy | Medium | Telegram has message access |
| Bot Privacy | High | Bot only sees direct messages |
| Webhook Security | Medium | Use secret token |

### Webhook Security

When using webhooks instead of polling:

```typescript
// Webhook with secret token
bot.api.setWebhook("https://your-domain.com/webhook", {
  secret_token: process.env["TELEGRAM_WEBHOOK_SECRET"],
});

// Verify in handler
if (request.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
  return { status: 401 };
}
```

### Best Practices

1. **Use Long Polling in Development**: Easier to debug
2. **Use Webhooks in Production**: Better performance and reliability
3. **Restrict Bot Visibility**: Set privacy mode in BotFather
4. **Monitor Access Logs**: Track unauthorized attempts
5. **Rotate Tokens**: If compromised, revoke via BotFather

## Discord Security

### Authentication Model

Discord provides multiple authentication mechanisms:

1. **Bot Token**: Standard bot authentication
2. **User ID Whitelist**: Specific users allowed
3. **Role-Based Access**: Users with specific roles
4. **Guild Restrictions**: Limit to specific servers

### Security Controls

```typescript
// src/channels/discord/bot.ts
this.client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  if (!this.auth.isDiscordUserAllowed(userId)) {
    await message.reply(
      "You are not authorized to use Strata Brain. Contact the administrator."
    );
    return;
  }

  // Process message...
});
```

### Role-Based Access

```typescript
// src/security/auth.ts
isDiscordUserAllowed(userId: string, userRoles?: string[]): boolean {
  // If no restrictions set, deny all (Discord requires explicit configuration)
  if (this.allowedDiscordUserIds.size === 0 && this.allowedDiscordRoleIds.size === 0) {
    return false;
  }

  // Check if user ID is explicitly allowed
  if (this.allowedDiscordUserIds.has(userId)) {
    return true;
  }

  // Check if user has an allowed role
  if (userRoles && userRoles.length > 0) {
    const hasAllowedRole = userRoles.some((role) => this.allowedDiscordRoleIds.has(role));
    if (hasAllowedRole) {
      return true;
    }
  }

  return false;
}
```

### Configuration

```bash
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token

# Optional - User whitelist
ALLOWED_DISCORD_USER_IDS=123456789012345678,876543210987654321

# Optional - Role whitelist
ALLOWED_DISCORD_ROLE_IDS=987654321098765432

# Optional - Guild restriction
DISCORD_GUILD_ID=123456789012345678
```

### Security Considerations

| Aspect | Security Level | Notes |
|--------|---------------|-------|
| Transport | High | TLS 1.2+ via Gateway |
| Authentication | High | Bot token + user/role checks |
| DM Security | Medium | DMs bypass some controls |
| Permission System | High | Granular Discord permissions |
| Audit Log | High | Discord provides audit logs |

### Gateway Intents

Request only necessary intents:

```typescript
this.client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});
```

### Interaction Security

```typescript
private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  // Verify authorization
  if (!this.auth.isDiscordUserAllowed(interaction.user.id)) {
    await interaction.reply({
      content: "Unauthorized",
      ephemeral: true, // Only visible to user
    });
    return;
  }

  // Process interaction...
}
```

### Best Practices

1. **Minimize Gateway Intents**: Request only what you need
2. **Use Ephemeral Replies**: For sensitive operations
3. **Enable DM Restrictions**: Limit DMs if not needed
4. **Monitor Guild Events**: Track unauthorized server invites
5. **Use Slash Commands**: Better validation than text parsing

## Slack Security

### Authentication Model

Slack has the most complex authentication model:

1. **Bot Token** (`xoxb-`): Authenticates the bot
2. **Signing Secret**: Validates webhook requests (HMAC-SHA256)
3. **App Token** (`xapp-`): For Socket Mode connections
4. **Workspace Whitelist**: Allowed workspace IDs
5. **User Whitelist**: Allowed user IDs

### Request Signing

```typescript
// src/channels/slack/app.ts
import { createHmac } from "crypto";

function verifySlackRequest(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  // Check timestamp (prevent replay attacks)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false; // Request too old
  }

  // Verify signature
  const baseString = `v0:${timestamp}:${body}`;
  const expected = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  
  return signature === `v0=${expected}`;
}
```

### Security Controls

```typescript
private async handleIncomingMessage(message: SlackMessageEvent, say: SayFn): Promise<void> {
  if (message.subtype === "bot_message" || !message.text) return;

  const userId = message.user;
  const teamId = message.team || "";

  // Workspace check
  if (this.config.allowedWorkspaces?.length &&
      !this.config.allowedWorkspaces.includes(teamId)) {
    this.logger.warn("Unauthorized workspace", { teamId, userId });
    await say("❌ This workspace is not authorized to use Strata Brain.");
    return;
  }

  // User check
  if (this.config.allowedUserIds?.length &&
      (!userId || !this.config.allowedUserIds.includes(userId))) {
    this.logger.warn("Unauthorized user", { userId, teamId });
    await say("❌ You are not authorized to use Strata Brain.");
    return;
  }

  // Process message...
}
```

### Configuration

```bash
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Required for Socket Mode
SLACK_APP_TOKEN=xapp-...
SLACK_SOCKET_MODE=true

# Optional - Workspace whitelist
ALLOWED_SLACK_WORKSPACES=T1234567890

# Optional - User whitelist
ALLOWED_SLACK_USER_IDS=U1234567890
```

### Security Considerations

| Aspect | Security Level | Notes |
|--------|---------------|-------|
| Transport | High | TLS 1.2+ required |
| Authentication | Very High | HMAC-SHA256 signing |
| Replay Protection | High | Timestamp validation |
| Socket Mode | High | No public webhook URL |
| Enterprise Security | High | Enterprise Grid support |

### Socket Mode vs HTTP Mode

```
┌─────────────────────────────────────────────────────────────┐
│                   Socket Mode (Recommended)                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐           WebSocket           ┌──────────┐   │
│  │  Slack   │◄─────────────────────────────►│   Bot    │   │
│  │  Server  │        (Authenticated)        │  Server  │   │
│  └──────────┘                               └──────────┘   │
│                                                              │
│  Benefits:                                                  │
│  - No public URL needed                                     │
│  - Firewall-friendly                                        │
│  - Automatic reconnection                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     HTTP Mode                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐         HTTPS Webhook         ┌──────────┐   │
│  │  Slack   │──────────────────────────────►│   Bot    │   │
│  │  Server  │      (Signed requests)        │  Server  │   │
│  └──────────┘                               └──────────┘   │
│         ▲                                    │               │
│         │           Public Internet          │               │
│         └────────────────────────────────────┘               │
│                                                              │
│  Considerations:                                            │
│  - Requires public HTTPS endpoint                           │
│  - Must validate request signatures                         │
│  - Firewall rules needed                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Best Practices

1. **Use Socket Mode**: More secure, no public endpoint needed
2. **Validate All Requests**: Always check signatures
3. **Check Timestamps**: Prevent replay attacks
4. **Whitelist Workspaces**: Don't allow any workspace
5. **Monitor Events**: Track auth failures

## WhatsApp Security

### Authentication Model

WhatsApp Web via Baileys library (`@whiskeysockets/baileys`):

1. **QR Code Authentication**: On first run, scan the QR code from the terminal
2. **Session Persistence**: Session is saved to disk for automatic reconnection
3. **Allowed Numbers Whitelist**: Only explicitly allowed phone numbers can interact
4. **Per-user Rate Limiting**: Shared `RateLimiter` instance enforces message rate limits

### Security Controls

```typescript
// src/channels/whatsapp/client.ts
// Auth check in message handler
if (this.allowedNumbers.size > 0) {
  const normalized = senderId.replace(/@.*$/, "");
  if (!this.allowedNumbers.has(normalized)) {
    logger.warn("WhatsApp: unauthorized number", { senderId });
    void this.sendText(chatId, "Unauthorized. Contact the admin.");
    continue;
  }
}

// Rate limit check
const rateResult = this.rateLimiter.checkMessageRate(senderId);
if (!rateResult.allowed) {
  logger.warn("WhatsApp: rate limited", { senderId, reason: rateResult.reason });
  void this.sendText(
    chatId,
    `Rate limited. ${rateResult.reason ?? "Please wait before sending more messages."}`,
  );
  continue;
}
```

### Security Considerations

| Aspect | Security Level | Notes |
|--------|---------------|-------|
| Transport | High | TLS via WhatsApp Web protocol |
| E2E Encryption | Very High | WhatsApp E2E encryption |
| Authentication | Medium | QR code + session file |
| Number Whitelist | High | Explicit allowed numbers |
| Rate Limiting | High | Per-user rate limiting via shared RateLimiter |

### Configuration

```bash
# WhatsApp Web (Baileys)
WHATSAPP_SESSION_PATH=.whatsapp-session  # Session storage directory (default: .whatsapp-session)
WHATSAPP_ALLOWED_NUMBERS=1234567890,0987654321  # Comma-separated phone numbers
```

### Best Practices

1. **Restrict Allowed Numbers**: Set `WHATSAPP_ALLOWED_NUMBERS` to limit access
2. **Secure Session Files**: Protect the session directory (`WHATSAPP_SESSION_PATH`) with filesystem permissions
3. **Monitor Reconnections**: WhatsApp uses exponential backoff reconnection (max 10 attempts)
4. **Rate Limit**: Per-user rate limiting is enforced (default: 20 messages/minute, 200/hour)
5. **Session Timeouts**: Inactive sessions auto-expire after 30 minutes

## Common Security Features

### Rate Limiting

All channels implement rate limiting:

```typescript
// src/security/rate-limiter.ts
export class RateLimiter {
  checkMessageRate(userId: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(userId);

    // Prune expired timestamps
    bucket.minuteTimestamps = bucket.minuteTimestamps.filter((t) => t > now - 60_000);
    bucket.hourTimestamps = bucket.hourTimestamps.filter((t) => t > now - 3_600_000);

    // Check per-minute limit
    if (this.config.messagesPerMinute > 0 &&
        bucket.minuteTimestamps.length >= this.config.messagesPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit: max ${this.config.messagesPerMinute} messages/minute`,
        retryAfterMs: Math.max(bucket.minuteTimestamps[0]! + 60_000 - now, 1000),
      };
    }

    // Also checks: per-hour, daily token quota, daily/monthly budget
    bucket.minuteTimestamps.push(now);
    bucket.hourTimestamps.push(now);
    return { allowed: true };
  }
}
```

### Message Size Limits

```typescript
const MAX_MESSAGE_LENGTH = 4000; // Most platforms

function truncateMessage(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}
```

### Confirmation Timeouts

```typescript
// Slack: 5-minute timeout for confirmations
private readonly CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Telegram/Discord: 2-minute timeout for confirmations
const timeout = setTimeout(() => {
  this.pendingConfirmations.delete(confirmId);
  resolve("timeout");
}, 120_000); // 2 minutes
```

### Secret Sanitization

All channel outputs go through secret sanitization:

```typescript
import { sanitizeSecrets } from "../security/secret-sanitizer.js";

async function sendMessage(channelId: string, text: string) {
  const safeText = sanitizeSecrets(text);
  await this.client.sendMessage(channelId, safeText);
}
```

## Best Practices

### 1. Channel Selection

Choose the right channel for your security requirements:

| Requirement | Recommended Channel |
|-------------|---------------------|
| Highest security | Slack (Socket Mode) |
| Simple setup | Telegram |
| Role-based access | Discord |
| E2E encryption | WhatsApp |

### 2. Multi-Channel Deployment

When using multiple channels:

```typescript
// src/core/bootstrap.ts selects a single channel via channelType
// Each channel type is initialized with its own auth checks
async function initializeChannel(
  channelType: string,
  config: Config,
  auth: AuthManager,
  logger: winston.Logger,
): Promise<IChannelAdapter> {
  switch (channelType) {
    case "telegram":
      return new TelegramChannel(config.telegram.botToken!, auth);
    case "discord":
      return new DiscordChannel(config.discord.botToken!, auth, { ... });
    case "whatsapp":
      return new WhatsAppChannel(sessionPath, allowedNumbers);
    case "cli":
      return new CLIChannel();
  }
}
```

### 3. Monitoring

Monitor all channels for security events:

```typescript
getLogger().info("Security event", {
  channel: "telegram",
  event: "unauthorized_access",
  userId: ctx.from?.id,
  timestamp: new Date().toISOString(),
});
```

### 4. Fail-Safe Defaults

```typescript
// Default to secure configuration
const config = {
  allowedTelegramIds: parseIds(process.env["ALLOWED_TELEGRAM_USER_IDS"]) ?? [],
  allowedSlackWorkspaces: parseIds(process.env["ALLOWED_SLACK_WORKSPACES"]) ?? [],
  // Empty arrays = no one allowed (fail secure)
};
```

### 5. Regular Security Reviews

- Review access lists monthly
- Rotate tokens quarterly
- Audit logs weekly
- Update blocklists as needed

---

Last updated: 2026-03-03
