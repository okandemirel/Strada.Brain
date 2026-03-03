# Authentication

This document describes the authentication mechanisms, token management, and session handling in Strata Brain.

## Table of Contents

- [Overview](#overview)
- [Authentication Mechanisms](#authentication-mechanisms)
- [Multi-Channel Authentication](#multi-channel-authentication)
- [Token Management](#token-management)
- [Session Handling](#session-handling)
- [Implementation Details](#implementation-details)
- [Configuration](#configuration)
- [Best Practices](#best-practices)

## Overview

Strata Brain implements a multi-channel authentication system that supports Telegram, Discord, and Slack. Each channel has its own authentication mechanism while sharing a common authorization framework.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Authentication Flow                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────┐    ┌─────────────┐    ┌─────────────────────┐    │
│   │  User   │───►│   Channel   │───►│  AuthManager.check  │    │
│   │ Request │    │   Adapter   │    │  (Platform-specific)│    │
│   └─────────┘    └─────────────┘    └──────────┬──────────┘    │
│                                                 │                │
│                    ┌────────────────────────────┘                │
│                    │                                             │
│                    ▼                                             │
│          ┌───────────────────┐                                   │
│          │   Whitelist Check  │                                  │
│          │  - User ID valid?  │                                  │
│          │  - Role allowed?   │                                  │
│          │  - Workspace OK?   │                                  │
│          └─────────┬─────────┘                                   │
│                    │                                             │
│         ┌─────────┴─────────┐                                    │
│         │                   │                                    │
│         ▼                   ▼                                    │
│   ┌──────────┐       ┌──────────┐                               │
│   │ Allowed  │       │ Denied   │                               │
│   │ Continue │       │ Log &    │                               │
│   │ Process  │       │ Reject   │                               │
│   └──────────┘       └──────────┘                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication Mechanisms

### Telegram Authentication

Telegram uses bot tokens and user ID validation for authentication.

#### How It Works

1. **Bot Token**: Validates the bot's identity with Telegram servers
2. **User ID Whitelist**: Only explicitly allowed users can interact
3. **Webhook Security**: Optional secret token for webhook validation

#### Implementation

```typescript
// src/channels/telegram/bot.ts
private setupMiddleware(): void {
  this.bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!this.auth.isTelegramUserAllowed(userId)) {
      await ctx.reply("You are not authorized to use Strata Brain.");
      return;
    }

    await next();
  });
}
```

#### Security Features

- User ID is immutable (bound to Telegram account)
- Bot token never exposed to clients
- Optional: Webhook secret token validation

### Discord Authentication

Discord authentication supports both user-based and role-based access control.

#### How It Works

1. **Bot Token**: Authenticates the bot with Discord gateway
2. **User ID Whitelist**: Specific users allowed
3. **Role-based Access**: Users with specific roles allowed
4. **Guild Restrictions**: Optional guild (server) restrictions

#### Implementation

```typescript
// src/security/auth.ts
isDiscordUserAllowed(userId: string, userRoles?: string[]): boolean {
  // Explicit user ID match
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

#### Security Features

- Role hierarchy support
- Runtime role/user management
- DM vs. channel differentiation

### Slack Authentication

Slack uses a multi-layer authentication approach with workspace and user validation.

#### How It Works

1. **Bot Token** (`xoxb-`): Authenticates the bot
2. **Signing Secret**: Validates webhook requests
3. **App Token** (`xapp-`): For Socket Mode connections
4. **Workspace Whitelist**: Allowed workspace IDs
5. **User Whitelist**: Allowed user IDs

#### Implementation

```typescript
// src/channels/slack/app.ts
private async handleIncomingMessage(
  message: SlackMessageEvent,
  say: SayFn
): Promise<void> {
  const teamId = message.team || "";
  const userId = message.user;

  // Check workspace
  if (this.config.allowedWorkspaces?.length && 
      !this.config.allowedWorkspaces.includes(teamId)) {
    await say("❌ This workspace is not authorized.");
    return;
  }

  // Check user
  if (this.config.allowedUserIds?.length && 
      (!userId || !this.config.allowedUserIds.includes(userId))) {
    await say("❌ You are not authorized to use Strata Brain.");
    return;
  }
}
```

#### Security Features

- Request signing verification (HMAC-SHA256)
- Socket Mode for private networks
- Enterprise Grid support

## Multi-Channel Authentication

### AuthManager Class

The `AuthManager` centralizes authentication across all channels:

```typescript
// src/security/auth.ts
export class AuthManager {
  private readonly allowedTelegramIds: Set<number>;
  private readonly allowedSlackIds: Set<string>;
  private readonly allowedSlackWorkspaces: Set<string>;
  private readonly allowedDiscordUserIds: Set<string>;
  private readonly allowedDiscordRoleIds: Set<string>;

  // Channel-specific checks
  isTelegramUserAllowed(userId: number): boolean
  isSlackUserAllowed(userId: string): boolean
  isSlackWorkspaceAllowed(workspaceId: string): boolean
  isDiscordUserAllowed(userId: string, userRoles?: string[]): boolean
}
```

### Cross-Channel Consistency

All channels follow the same pattern:

1. Extract identity from incoming message
2. Check against whitelist
3. Log unauthorized attempts
4. Proceed or reject

## Token Management

### Token Types

| Token Type | Format | Purpose | Storage |
|------------|--------|---------|---------|
| Telegram Bot Token | `123456:ABC-DEF...` | Bot authentication | Environment variable |
| Discord Bot Token | Standard JWT | Bot authentication | Environment variable |
| Slack Bot Token | `xoxb-...` | Bot authentication | Environment variable |
| Slack Signing Secret | Random string | Request validation | Environment variable |
| Slack App Token | `xapp-...` | Socket Mode | Environment variable |

### Secure Token Storage

```bash
# .env file - Restrict permissions!
chmod 600 .env

# Contents
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234...
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token-here
SLACK_SIGNING_SECRET=abc123def456...
DISCORD_BOT_TOKEN=YOUR_DISCORD_BOT_TOKEN
```

### Token Rotation

1. Generate new token from platform dashboard
2. Update environment variable
3. Restart service
4. Revoke old token

```bash
# Example rotation script
#!/bin/bash
# 1. Backup current config
cp .env .env.backup

# 2. Update token
sed -i 's/OLD_TOKEN/NEW_TOKEN/' .env

# 3. Restart service
pm2 restart strata-brain

# 4. Verify
curl -f http://localhost:3000/health || exit 1

# 5. Remove backup
rm .env.backup
```

## Session Handling

### Session Characteristics

Strata Brain uses stateless session management:

- **No server-side sessions**: Each request is independently authenticated
- **Token-based**: Platform tokens provide continuous authentication
- **Memory-only**: Runtime state is not persisted

### Message Context

Each incoming message includes authentication context:

```typescript
// src/channels/channel-messages.interface.ts
interface IncomingMessage {
  channelType: "telegram" | "discord" | "slack" | "whatsapp";
  chatId: string;
  userId: string;
  text: string;
  timestamp: Date;
  // No session ID - stateless
}
```

### Connection Persistence

```
┌─────────────────────────────────────────────────────────────┐
│                  Connection Lifecycle                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Connect                                                   │
│      │                                                       │
│      ▼                                                       │
│   ┌────────────┐                                            │
│   │  Validate  │── Error ──► Retry with backoff             │
│   │   Token    │                                            │
│   └─────┬──────┘                                            │
│         │ Success                                            │
│         ▼                                                    │
│   ┌────────────┐                                            │
│   │  Maintain  │◄──── Heartbeat/Ping                        │
│   │ Connection │                                            │
│   └─────┬──────┘                                            │
│         │                                                    │
│    Disconnect │                                              │
│         │                                                    │
│         ▼                                                    │
│   ┌────────────┐                                            │
│   │   Cleanup  │──► Clear pending confirmations            │
│   │            │──► Release resources                        │
│   └────────────┘                                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Details

### Telegram Deep Dive

```typescript
// src/channels/telegram/bot.ts
export class TelegramChannel implements IChannelAdapter {
  constructor(token: string, auth: AuthManager) {
    this.bot = new Bot(token);
    this.auth = auth;
    this.setupMiddleware();
  }

  private setupMiddleware(): void {
    // Auth middleware - first line of defense
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.auth.isTelegramUserAllowed(userId)) {
        getLogger().warn("Unauthorized Telegram access", { userId });
        await ctx.reply("You are not authorized.");
        return;
      }

      await next();
    });

    // Error handler
    this.bot.catch((err) => {
      getLogger().error("Telegram bot error", { error: err.message });
    });
  }
}
```

### Discord Deep Dive

```typescript
// src/channels/discord/bot.ts
private setupEventHandlers(): void {
  this.client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Authorization check
    const userId = message.author.id;
    if (!this.auth.isDiscordUserAllowed(userId)) {
      await message.reply("You are not authorized.");
      return;
    }

    // Process message...
  });

  this.client.on(Events.InteractionCreate, async (interaction) => {
    // Check authorization for interactions
    if (!this.auth.isDiscordUserAllowed(interaction.user.id)) {
      await interaction.reply({
        content: "Unauthorized",
        ephemeral: true
      });
      return;
    }
  });
}
```

### Slack Deep Dive

```typescript
// src/channels/slack/app.ts
private registerEventHandlers(): void {
  this.app.message(async ({ message, say }) => {
    await this.handleIncomingMessage(message as SlackMessageEvent, say);
  });

  this.app.action(/confirm_.*/, async ({ ack, body, action }) => {
    await ack();

    // Auth check on actions
    const userId = body.user?.id;
    if (!userId || !this.auth.isSlackUserAllowed(userId)) {
      return;
    }

    // Process action...
  });
}
```

## Configuration

### Environment Variables

```bash
# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
ALLOWED_TELEGRAM_USER_IDS=123456789,987654321

# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token
ALLOWED_DISCORD_USER_IDS=123456789012345678
ALLOWED_DISCORD_ROLE_IDS=987654321098765432

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
SLACK_SOCKET_MODE=true
ALLOWED_SLACK_WORKSPACES=T1234567890
ALLOWED_SLACK_USER_IDS=U1234567890
```

### Dynamic Configuration

Some authentication settings can be modified at runtime:

```typescript
// Add Discord user at runtime
authManager.addDiscordUser("123456789");

// Add Discord role at runtime
authManager.addDiscordRole("987654321");

// Check current status
const status = authManager.getDiscordAuthStatus();
console.log(status);
// { allowedUserCount: 5, allowedRoleCount: 2, hasAnyRestrictions: true }
```

## Best Practices

### 1. Principle of Least Privilege

Only grant access to users who absolutely need it:

```bash
# Good - Specific users
ALLOWED_TELEGRAM_USER_IDS=123456789

# Risky - Too broad (if you have many users)
ALLOWED_TELEGRAM_USER_IDS=123456789,987654321,111111111,...
```

### 2. Regular Access Reviews

Periodically review and clean up access lists:

```typescript
// Audit script
const auth = createAuthManagerFromEnv();
console.log("Current Access:");
console.log("Telegram:", auth.getAllowedTelegramIds());
console.log("Discord Users:", auth.getAllowedDiscordUserIds());
console.log("Discord Roles:", auth.getAllowedDiscordRoleIds());
console.log("Slack Users:", auth.getAllowedSlackIds());
console.log("Slack Workspaces:", auth.getAllowedSlackWorkspaces());
```

### 3. Monitoring and Alerting

Set up alerts for unauthorized access attempts:

```typescript
// In your logging system
if (!auth.isTelegramUserAllowed(userId)) {
  getLogger().warn("Unauthorized access attempt", {
    userId,
    channel: "telegram",
    timestamp: new Date().toISOString()
  });
  
  // Send alert to admin
  await notifyAdmin(`Unauthorized access from user ${userId}`);
}
```

### 4. Token Security

- Never commit tokens to version control
- Use secret management systems in production
- Rotate tokens regularly
- Monitor for token leakage

### 5. Defense in Depth

Combine multiple authentication controls:

```
User Request
    │
    ├──► Channel Token Validation
    │
    ├──► User ID Whitelist
    │
    ├──► Role/Workspace Check (if applicable)
    │
    └──► Rate Limit Check
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Not authorized" | User ID not in whitelist | Add user ID to environment |
| Token invalid | Token expired/revoked | Generate new token |
| Rate limited | Too many requests | Implement backoff |
| Webhook fails | SSL/URL issue | Check certificate and URL |

---

Last updated: 2026-03-02
