# src/channels/

Channel adapters connect Strada.Brain to messaging platforms. Each adapter translates platform-specific events into the unified `IChannelAdapter` interface consumed by the orchestrator.

## Supported Channels

| Channel | Class | Library | Auth Default |
|---------|-------|---------|--------------|
| Telegram | `TelegramChannel` | Grammy | Deny-all (must set allowlist) |
| Discord | `DiscordChannel` | discord.js | Deny-all (must set allowlist) |
| Slack | `SlackChannel` | @slack/bolt | **Open-all** (must set allowlist for production) |
| WhatsApp | `WhatsAppChannel` | @whiskeysockets/baileys | Deny-all (must set allowlist) |
| Matrix | `MatrixChannel` | matrix-js-sdk | Deny-all unless `MATRIX_ALLOW_OPEN_ACCESS=true` |
| IRC | `IRCChannel` | irc | Deny-all unless `IRC_ALLOW_OPEN_ACCESS=true` |
| Teams | `TeamsChannel` | botbuilder | Deny-all unless `TEAMS_ALLOW_OPEN_ACCESS=true` |
| Web | `WebChannel` | ws (WebSocket) | Localhost-only binding |
| CLI | `CLIChannel` | node:readline | No auth needed |

## Interface Architecture

The abstraction follows Interface Segregation across three layers:

**Required interfaces** (all adapters implement these via `IChannelAdapter`):
- `IChannelCore` — `connect()`, `disconnect()`, `isHealthy()`
- `IChannelReceiver` — `onMessage(handler)`
- `IChannelSender` — `sendText()`, `sendMarkdown()`

**Optional interfaces** (detected at runtime via type guards):
- `IChannelStreaming` — `startStreamingMessage()`, `updateStreamingMessage()`, `finalizeStreamingMessage()`
- `IChannelRichMessaging` — `sendTypingIndicator()`, `sendAttachment()`
- `IChannelInteractive` — `requestConfirmation()`

Runtime detection:
```typescript
if (supportsStreaming(channel)) { /* use streaming */ }
if (supportsRichMessaging(channel)) { /* send typing indicator */ }
if (supportsInteractivity(channel)) { /* request confirmation */ }
```

## Message Types

Normalized types decouple the orchestrator from any platform:

- `IncomingMessage` — `{ channelType, chatId, userId, text, attachments?, replyTo?, timestamp }`
- `OutgoingMessage` — `{ chatId, text, format?, attachments?, replyTo? }`
- `ChannelType` — `"telegram" | "whatsapp" | "cli" | "web" | "discord" | "slack"`

## Message Flow

```
Platform event (Telegram message, Discord interaction, etc.)
  → Adapter's event handler
  → Authentication check (allowlists or explicit open-access opt-in)
  → Rate limit check (per-user sliding window)
  → Normalize to IncomingMessage
  → Call messageHandler (set by bootstrap via onMessage())
  → Orchestrator processes message
  → Orchestrator calls channel.sendMarkdown() or streaming methods
```

## Streaming

All five channels implement edit-in-place streaming:

1. **Start:** Send placeholder message, return a `streamId`
2. **Update:** Edit the same message with accumulated text (throttled)
3. **Finalize:** Send complete final text, cancel pending throttle timers

Throttle rates:
- WhatsApp/Discord: 1 update/second (`setTimeout` queue)
- Slack: 2 updates/second (`StreamingRateLimiter`)
- Telegram: no client-side throttle (relies on Telegram's 30 edits/sec limit)
- CLI: terminal cursor rewrite (`\r\x1b[K`)

All `finalizeStreamingMessage` implementations fall back to sending a new message if the edit fails.

## Rate Limiting

Two distinct systems coexist intentionally:

**Inbound (per-user):** `RateLimiter` from `src/security/rate-limiter.ts` — sliding window per minute/hour, token quotas, budget caps. Used by WhatsApp inline and orchestrator-level.

**Outbound (per-platform):**
- Discord: Token bucket (50 req/sec global, 5/5sec per channel)
- Slack: 4-tier sliding window matching Slack's API tiers (60/min for postMessage, 20/min for conversations, etc.)
- Discord/Slack also use internal message queues with exponential backoff retry (up to 3 retries)

## Session Management

- **WhatsApp:** Full per-channel session tracking. `Map<string, SessionState>` with 30-minute timeout, 5-minute cleanup interval.
- **Other channels:** Session tracking handled by the orchestrator (not the channel adapter).
- **All channels:** Pending confirmations tracked in `Map<string, {resolve, timeout}>` with 2-5 minute timeouts. Drained on `disconnect()`.

## Capability Matrix

| | Streaming | Typing | Confirmation | Files | Threads |
|---|---|---|---|---|---|
| Telegram | Yes (editMessageText) | Yes (sendChatAction) | Yes (InlineKeyboard) | No | No |
| Discord | Yes (message.edit) | Yes (sendTyping) | Yes (ButtonBuilder) | No | Yes |
| Slack | Yes (chat.update) | No-op | Yes (Block Kit) | Yes (uploadFile) | Yes |
| WhatsApp | Yes (edit-in-place) | Yes (composing/paused) | Yes (numbered reply) | Yes (sendImage/sendDocument) | No |
| Web | Yes (stream_update) | Yes (typing) | Yes (JSON dialog) | Yes (metadata) | No |
| CLI | Yes (stdout rewrite) | No | Yes (readline) | No | No |

## Web Channel

Browser-based chat interface using HTTP static file serving and WebSocket for real-time bidirectional communication.

**Class:** `WebChannel`
**Library:** `ws` (Node.js WebSocket server)
**Location:** `src/channels/web/`

### Architecture

The Web channel combines HTTP and WebSocket transports:

1. **HTTP Server** — Serves static files (HTML, CSS, JS) with strict security headers
2. **WebSocket Server** — Handles real-time message and confirmation exchange

All communication is localhost-only (`127.0.0.1`). WebSocket connections validate the `Origin` header to block cross-origin hijacking, allowing only `localhost` and `127.0.0.1`.

### Key Features

**Static File Serving:**
- Serves `src/channels/web/static/` directory with content-type detection
- Supports HTML, CSS, JavaScript, JSON, images (PNG, SVG, ICO)
- Path traversal attacks prevented via `resolve()` normalization + directory confinement check
- Only GET requests allowed; 405 for other methods

**WebSocket Communication:**
- Assigns each connection a unique `chatId` (UUID)
- Bidirectional JSON messaging: server sends `type: "text" | "markdown" | "confirmation" | "stream_*" | "typing"`, client sends `type: "message" | "confirmation_response"`
- Maximum payload: 1 MiB (prevents memory exhaustion)

**Streaming Support:**
- `startStreamingMessage()` — Send placeholder, return `streamId`
- `updateStreamingMessage()` — Edit message with accumulated text (no throttle, real-time)
- `finalizeStreamingMessage()` — Send final complete text

**Confirmation Dialogs:**
- `requestConfirmation()` — Send dialog with question, options, and details
- 5-minute timeout with automatic cleanup
- Client responds with selected option via WebSocket
- Falls back to "timeout" if no response received

**Typing Indicator:**
- `sendTypingIndicator()` — Send `{type: "typing", active: true}` to UI

**Attachment Metadata:**
- `sendAttachment()` — Sends text representation `[Attachment: filename]`

### Security

**HTTP Response Headers:**
- `X-Content-Type-Options: nosniff` — Prevent MIME type sniffing
- `X-Frame-Options: DENY` — Block iframe embedding
- `Referrer-Policy: no-referrer` — Prevent referrer leakage
- `Content-Security-Policy` — Restrict scripts/styles to self + Cloudflare CDN, allow WebSocket to localhost only, block inline scripts and unsafe-eval

**WebSocket Validation:**
- `verifyClient` hook validates `Origin` header before accepting connection
- Only `localhost` and `127.0.0.1` allowed (blocks CSRF from different hosts)
- Non-browser clients (CLI tools, tests) without Origin header are accepted

**Path Traversal Protection:**
- Uses `path.resolve()` to normalize paths and eliminate `../` and URL-encoded variants (`%2e%2e`)
- Validates resolved path is still within `STATIC_DIR` before reading
- Returns 403 Forbidden if path escapes directory

### Configuration

Constructor parameter:
```typescript
new WebChannel(port?: number = 3000)
```

Default port is 3000. Server binds to `127.0.0.1:3000` (localhost).

### Message Protocol

**Server → Client:**
```typescript
{ type: "connected", chatId: string }
{ type: "text", text: string, messageId: string }
{ type: "markdown", text: string, messageId: string }
{ type: "typing", active: boolean }
{ type: "confirmation", confirmId: string, question: string, options: string[], details?: string }
{ type: "stream_start", streamId: string, text: string }
{ type: "stream_update", streamId: string, text: string }
{ type: "stream_end", streamId: string, text: string }
```

**Client → Server:**
```typescript
{ type: "message", text: string }
{ type: "confirmation_response", confirmId: string, option: string }
```

## Adding a New Channel

1. Create `src/channels/my-channel/` directory
2. Implement `IChannelAdapter` from `channel.interface.ts`
3. Optionally implement `IChannelStreaming`, `IChannelRichMessaging`, `IChannelInteractive`
4. Add initialization to `initializeChannel()` in `src/core/bootstrap.ts`
5. Write tests in `my-channel.test.ts`

## Key Files

| File | Purpose |
|------|---------|
| `channel-core.interface.ts` | Segregated interfaces + type guards |
| `channel.interface.ts` | Unified `IChannelAdapter` |
| `channel-messages.interface.ts` | `IncomingMessage`, `OutgoingMessage`, `ChannelType` |
| `telegram/bot.ts` | Grammy-based Telegram adapter |
| `discord/bot.ts` | discord.js adapter with slash commands |
| `discord/rate-limiter.ts` | Token bucket + per-channel rate limiter |
| `slack/app.ts` | Slack Bolt adapter (socket mode) |
| `slack/rate-limiter.ts` | 4-tier sliding window + streaming limiter |
| `whatsapp/client.ts` | Baileys adapter with session management |
| `cli/repl.ts` | Readline REPL adapter |
