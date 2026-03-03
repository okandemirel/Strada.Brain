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
┌─────────────────────────────────────────────────────────────────┐
│                     Channel Security Model                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Telegram   │  │   Discord   │  │    Slack    │             │
│  │             │  │             │  │             │             │
│  │ • Bot Token │  │ • Bot Token │  │ • Bot Token │             │
│  │ • User ID   │  │ • User ID   │  │ • Sign Secret│            │
│  │   Whitelist │  │ • Role-based│  │ • Workspace │             │
│  │             │  │   Access    │  │   Whitelist │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                    │
│         └────────────────┴────────────────┘                    │
│                          │                                      │
│                          ▼                                      │
│               ┌─────────────────────┐                          │
│               │   AuthManager       │                          │
│               │   (Unified Auth)    │                          │
│               └─────────────────────┘                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
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
      getLogger().warn("Unauthorized Telegram access", { userId });
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
    getLogger().warn("Unauthorized Discord access", { userId });
    await message.reply("You are not authorized.");
    return;
  }

  // Process message...
});
```

### Role-Based Access

```typescript
// src/security/auth.ts
isDiscordUserAllowed(userId: string, userRoles?: string[]): boolean {
  // Explicit user whitelist
  if (this.allowedDiscordUserIds.has(userId)) {
    return true;
  }

  // Role-based access
  if (userRoles?.some(role => this.allowedDiscordRoleIds.has(role))) {
    return true;
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
    // GatewayIntentBits.GuildMembers, // Only if needed
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
private async handleIncomingMessage(
  message: SlackMessageEvent,
  say: SayFn
): Promise<void> {
  const teamId = message.team || "";
  const userId = message.user;

  // Workspace check
  if (this.config.allowedWorkspaces?.length && 
      !this.config.allowedWorkspaces.includes(teamId)) {
    getLogger().warn("Unauthorized Slack workspace", { teamId, userId });
    await say("❌ This workspace is not authorized.");
    return;
  }

  // User check
  if (this.config.allowedUserIds?.length && 
      (!userId || !this.config.allowedUserIds.includes(userId))) {
    getLogger().warn("Unauthorized Slack user", { userId, teamId });
    await say("❌ You are not authorized.");
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

WhatsApp Business API (via WhatsApp Business Platform):

1. **Access Token**: API authentication
2. **Phone Number ID**: Business phone identifier
3. **Webhook Verification**: Verify webhook authenticity

### Security Considerations

| Aspect | Security Level | Notes |
|--------|---------------|-------|
| Transport | High | TLS 1.2+ required |
| E2E Encryption | Very High | WhatsApp E2E encryption |
| API Security | High | Meta Business verification |
| Message Access | Medium | Meta has access |

### Configuration

```bash
# WhatsApp Business API
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
```

### Best Practices

1. **Verify Business Account**: Complete Meta verification
2. **Use Official API**: Don't use unofficial libraries
3. **Secure Webhooks**: Validate verify tokens
4. **Rate Limit**: Respect WhatsApp rate limits
5. **Opt-in Required**: Users must opt-in to messages

## Common Security Features

### Rate Limiting

All channels implement rate limiting:

```typescript
// src/security/rate-limiter.ts
export class RateLimiter {
  checkMessageRate(userId: string): RateLimitResult {
    // Per-user rate limiting
    const bucket = this.getBucket(userId);
    
    if (bucket.count > this.maxPerMinute) {
      return {
        allowed: false,
        reason: "Rate limit exceeded",
        retryAfterMs: bucket.resetTime - Date.now(),
      };
    }

    bucket.count++;
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
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Auto-expire pending confirmations
setTimeout(() => {
  if (pendingConfirmations.has(id)) {
    pendingConfirmations.delete(id);
    reject(new Error("Confirmation timeout"));
  }
}, CONFIRMATION_TIMEOUT_MS);
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
// Enable only needed channels
const channels: IChannelAdapter[] = [];

if (process.env["TELEGRAM_BOT_TOKEN"]) {
  channels.push(createTelegramChannel());
}

if (process.env["SLACK_BOT_TOKEN"]) {
  channels.push(createSlackChannel());
}

// Each channel has its own auth
const auth = createAuthManagerFromEnv();
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

Last updated: 2026-03-02
