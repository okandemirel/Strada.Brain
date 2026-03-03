# src/channels/

Channel adapters connect Strada.Brain to external messaging platforms. Each adapter translates platform-specific events into the unified `IChannelAdapter` interface consumed by the orchestrator.

## Architecture

All channel adapters implement the `IChannelAdapter` interface, which combines three segregated interfaces:

- **IChannelCore** -- `start()`, `stop()`, `onMessage()` lifecycle methods
- **IChannelSender** -- `sendText()`, `sendMarkdown()` for outbound messages
- **IChannelReceiver** -- `onMessage(callback)` for inbound message routing

Optional capabilities are detected at runtime via type guards:

- `supportsStreaming(channel)` -- real-time token streaming to the user
- `supportsRichMessaging(channel)` -- typing indicators, read receipts
- `supportsInteractivity(channel)` -- confirmation dialogs for write operations

## Directory Layout

```
channels/
  channel.interface.ts          # Unified IChannelAdapter (re-exports all types)
  channel-core.interface.ts     # IChannelCore, IChannelSender, IChannelReceiver
  channel-messages.interface.ts # IncomingMessage, OutgoingMessage, Attachment
  cli/                          # Readline-based local CLI adapter
  discord/                      # Discord.js bot adapter
  slack/                        # Slack Bolt (socket mode) adapter
  telegram/                     # Grammy-based Telegram adapter
  whatsapp/                     # Baileys-based WhatsApp adapter
```

## Adding a New Channel

1. Create a new directory under `src/channels/` (e.g., `src/channels/matrix/`).
2. Implement `IChannelAdapter` from `channel.interface.ts`.
3. Optionally implement `IChannelStreaming`, `IChannelRichMessaging`, or `IChannelInteractive`.
4. Register the new channel type in `src/common/constants.ts` (`SupportedChannelType`).
5. Add initialization logic to `src/core/bootstrap.ts`.

## Key Types

- `IncomingMessage` -- contains `chatId`, `userId`, `text`, `channelType`, optional `attachments`
- `OutgoingMessage` -- text or markdown content with optional metadata
- `ChannelType` -- `"slack" | "discord" | "telegram" | "whatsapp" | "cli"`
