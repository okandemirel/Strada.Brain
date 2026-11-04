---
id: key-rotation-inherits-cooldown
kind: gotcha
tier: 1
status: active
topics: ["providers", "ops"]
paths: ["src/agents/providers/**"]
purpose: "Stop a key or endpoint change from being misread as a dead provider when an old cooldown is still benching it."
summary: "Provider cooldowns persist across restarts in provider-health.json; read it first when every call is refused"
decided_on: 2026-09-10
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Cooldowns persist in `<home>/.strada-memory/provider-health.json` across restarts, and a burst of 401s benches a seat for 8 hours. Until 2026-09-10 a seat's identity was endpoint plus model, so a rotated key inherited the old bench: curl answered 200 while the daemon said "all providers in cooldown". The identity now includes a hash of the key. That fix takes effect on the first boot after it ships; older entries are upgraded, not cleared.

## Decision
When the daemon refuses every call right after a key or endpoint change, read that file first (`cooldownUntil`, `identity`). Stop the daemon, drop the stale entries, then start it again. Never edit the file while the daemon runs, because the daemon overwrites it.

## Rejected alternatives
- **Clear all cooldowns at boot.** That would throw away the bench a genuinely failing provider earned, and retry it in a loop.

## Consequences
A mission paused by recovery that turned `blocked` needs `/retry`, not `/resume`. The only hint is the reply "may not be paused".
