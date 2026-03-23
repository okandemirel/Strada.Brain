---
trigger: glob
globs: src/channels/**
---

# Channel Rules

- Each channel implements `src/channels/channel.interface.ts` (composite) and `src/channels/channel-core.interface.ts` (core ops)
- Channel code stays in `src/channels/{name}/`
- Web channel: 127.0.0.1 only (security)
- Media: SSRF protection + magic byte validation
- 9 channels: web, telegram, discord, slack, whatsapp, cli, matrix, irc, teams
- No channel-specific deps in shared code
