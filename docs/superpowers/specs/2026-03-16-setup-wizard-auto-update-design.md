# Setup Wizard & Auto-Update System Design

**Date:** 2026-03-16
**Status:** Approved
**Scope:** CLI entry point, terminal setup wizard, auto-update system

---

## Overview

Two features that improve the Strada Brain installation and maintenance experience:

1. **Setup Wizard**: `strada` CLI command with terminal-based quick setup + web setup option
2. **Auto-Update**: Automatic version detection and self-updating for both npm and git installations

---

## Feature 1: CLI Entry Point & Setup Wizard

### package.json Changes

Add `bin` field for global CLI access:
```json
{
  "bin": {
    "strada": "./dist/index.js"
  }
}
```

Supports both `npm install -g strada-brain` (global) and `npx strada-brain` (no install).

**Commander name change (implementation task):** `src/index.ts` currently uses `.name("strada-brain")` — rename to `.name("strada")` for consistency with the bin name. Add `strada-brain` as a secondary bin alias for backward compatibility:
```json
{
  "bin": {
    "strada": "./dist/index.js",
    "strada-brain": "./dist/index.js"
  }
}
```

### New CLI Commands

| Command | Description |
|---------|-------------|
| `strada setup` | Interactive setup wizard |
| `strada update` | Manual update trigger |
| `strada update --check` | Check for updates without applying |
| `strada version` | Current version + last update check time |

### Terminal Wizard Flow (`src/core/terminal-wizard.ts`)

```
$ strada setup

🦉 Strada Brain Setup
━━━━━━━━━━━━━━━━━━━━

? Setup method:
  ❯ Terminal (quick setup)
    Web Browser (full setup)

[Terminal selected:]
? Unity project path: ~/Projects/MyGame
? AI Provider API key (Claude/OpenAI/Gemini): sk-...
? Default channel: (web)
? Language: (en)

✅ .env created! Run `strada start` to begin.

[Web selected:]
🌐 Opening setup at http://localhost:{SETUP_WIZARD_PORT}/setup...
   (Open this URL in your browser if it didn't open automatically)
   (Port resolved from SETUP_WIZARD_PORT env var, default: 3000)
```

### Terminal Wizard Details

- Uses Node.js built-in `readline` (zero new dependencies)
- Required fields: Unity project path + at least 1 API key
- Optional fields: channel, language, preset — uses sensible defaults
- Writes `.env` in the same format as the existing web wizard
- Max 3 retry attempts for invalid input per question
- Existing `.env` detected → prompt "Overwrite existing config?" confirmation
- `Ctrl+C` → graceful exit, no partial `.env` written
- Web selection → starts setup wizard HTTP server (port from `SETUP_WIZARD_PORT` env, default 3000) + attempts `open` command, falls back to printing URL
- Path validation enforces same rules as web wizard: `realpath` resolution + must be inside `os.homedir()` (prevents directory traversal)

### Integration with Existing Setup

- `strada start` with no valid config → prints hint: "Run `strada setup` first"
- Existing `src/core/setup-wizard.ts` (web wizard) remains unchanged
- Terminal wizard reuses the same `.env` generation and validation logic

---

## Feature 2: Auto-Update System

### Architecture (`src/core/auto-updater.ts`)

```
AutoUpdater
├── detectInstallMethod(): "npm-global" | "npm-local" | "git"
├── checkForUpdate(): { available, currentVersion, latestVersion }
├── isIdle(): boolean
├── performUpdate(): Promise<void>
├── notifyChannels(msg): void
├── scheduleChecks(): void
```

### Install Method Detection

Three-way detection:
- `.git` directory exists in project root → `"git"` (cloned repo)
- No `.git` + `process.execPath` is inside `npm root -g` → `"npm-global"` (global install)
- No `.git` + local `node_modules` exists → `"npm-local"` (local install or npx)
- Detected once at init, cached for session lifetime

### Update Check

- **Trigger**: On startup + every `AUTO_UPDATE_INTERVAL_HOURS` (default: 24h)
- **npm**: `spawn('npm', ['view', 'strada-brain@{dist-tag}', 'version'])` → compare with local `package.json` version (dist-tag from `AUTO_UPDATE_CHANNEL`: `stable` → `@stable`, `latest` → `@latest`)
- **Timeouts**: 30s for version check commands, 5min for download/build commands. Timeout treated as network failure (silent skip).
- **git**: `spawn('git', ['fetch', 'origin', 'main'])` → compare `HEAD` vs `origin/main`
- All external commands use `spawn` with array arguments (no shell injection)

### Update Flow

```
1. New version detected
2. Notify all active channels:
   "🔄 Strada Brain v{new} available. Will update when idle."
3. Idle detection loop:
   - No active conversations (last message > AUTO_UPDATE_IDLE_TIMEOUT_MIN ago)
   - No running background tasks (BackgroundExecutor check)
4. When idle (update command depends on install method):
   npm-global: spawn('npm', ['install', '-g', 'strada-brain@latest'])
   npm-local:  spawn('npm', ['install', 'strada-brain@latest']) in project dir
   git:        save pre-pull SHA via git rev-parse HEAD, then
               spawn('git', ['pull', 'origin', 'main']) + spawn('npm', ['run', 'build'])
5. On success:
   - If running under `strada supervise`: process.exit(0) → auto-restart
   - If standalone: notify "Update downloaded. Please restart with `strada start`"
6. Post-restart notification: "✅ Updated to v{new}"
```

### Configuration

Added to `src/config/config.ts` with Zod validation:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Enable/disable update system |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Check frequency in hours |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Minutes since last activity to consider idle |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag: `stable` → `@stable` tag, `latest` → `@latest` tag. Zod schema: `z.enum(['stable', 'latest'])`. For git: `stable` = tagged releases only, `latest` = tip of main. To disable updates, use `AUTO_UPDATE_ENABLED=false` |
| `AUTO_UPDATE_NOTIFY` | `true` | Send notifications to users |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Auto-restart when idle (false = notify only) |

All values configurable via `.env` or environment variables. Not asked during terminal wizard setup (advanced config).

### Channel Integration

**Notification delivery:** AutoUpdater receives a reference to the active channel instances. Notifications sent via existing `sendMarkdown(chatId, msg)` method. Active chat IDs tracked by a `ChannelActivityRegistry` (new lightweight class) that records `{ channelName, chatId, lastMessageTimestamp }` on each incoming message.

**Idle detection:** `ChannelActivityRegistry.getLastActivityTime()` returns the most recent message timestamp across all channels. AutoUpdater compares this against `AUTO_UPDATE_IDLE_TIMEOUT_MIN`. Also checks `BackgroundExecutor.hasRunningTasks()` (new public method to be added — returns `this.running > 0 || this.queue.length > 0`).

**New file:** `src/core/channel-activity-registry.ts` — subscribes to channel message events, tracks per-chat activity timestamps, exposes `getActiveChatIds()` and `getLastActivityTime()`.

- Works across all channels: web, telegram, discord, slack, whatsapp, cli

### Bootstrap Integration

```typescript
// In bootstrap() after channel initialization:
if (config.autoUpdate.enabled) {
  const updater = new AutoUpdater(config, channels, backgroundExecutor);
  await updater.init();       // Initial check (fire-and-forget)
  updater.scheduleChecks();   // Periodic interval
}
```

---

## Error Handling & Edge Cases

### Terminal Wizard

| Scenario | Handling |
|----------|----------|
| Invalid Unity path | Error message + retry (max 3 per question) |
| Invalid API key format | Warning but accept (providers have different formats) |
| `.env` already exists | Prompt "Overwrite?" confirmation |
| `Ctrl+C` | Graceful exit, no partial `.env` |
| Browser can't open | Fall back to printing URL |

### Auto-Update

| Scenario | Handling |
|----------|----------|
| No network | Silent skip, retry next interval |
| npm/git not found | Log warning, disable auto-update for session |
| Build failure (git) | `git reset --hard {pre-pull-SHA}` (SHA saved before pull via `git rev-parse HEAD`), log error, notify user |
| Concurrent updates | Lockfile `.strada-update.lock` in project root — stores PID + timestamp. On lock acquisition, checks if PID is alive (`process.kill(pid, 0)`); stale lock (dead PID or older than 30min) is automatically removed |
| Command timeout | 30s for version checks, 5min for download/build — treated as network failure |
| Permission error | Log + notify user about permissions |
| Disk space issue | Catch npm/git error, log and notify |

### Security

- All external commands via `spawn` with argument arrays (no string concatenation)
- Git pull only from `origin` remote, only `main` branch
- npm update only for `strada-brain` package
- Lockfile prevents concurrent update races

---

## File Changes

| File | Change |
|------|--------|
| `package.json` | Add `bin` field, update version management |
| `src/index.ts` | Add shebang line, `setup`/`update`/`version` commands |
| `src/core/terminal-wizard.ts` | **New** — Terminal setup wizard |
| `src/core/auto-updater.ts` | **New** — Update detection, download, restart |
| `src/core/channel-activity-registry.ts` | **New** — Per-chat activity tracking for idle detection + notification delivery |
| `src/core/bootstrap.ts` | AutoUpdater + ChannelActivityRegistry init integration |
| `src/config/config.ts` | `AUTO_UPDATE_*` env vars with Zod schema |

---

## Testing Strategy

### Terminal Wizard Tests
- readline mock: question-answer flow
- `.env` file write/overwrite scenarios
- Path validation (invalid, traversal attempts)
- Web selection: browser open fallback
- `Ctrl+C` graceful exit

### Auto-Update Tests
- Install method detection (`.git` exists/missing)
- Version comparison (npm registry parse, git rev-parse)
- Idle detection (active/idle channel scenarios)
- Lockfile mechanism (concurrent update prevention)
- Network failure → graceful skip
- Build failure → rollback (git scenario)
- Config variations: enabled/disabled, intervals, timeouts
- Notification delivery (mock channels)

### Integration Tests
- `strada setup` end-to-end (terminal mode)
- `strada update --check` output verification
- Bootstrap → AutoUpdater init flow

All tests written with Vitest (existing test infrastructure).
