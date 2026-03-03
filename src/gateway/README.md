# src/gateway/

Process supervisor that keeps Strata Brain running as an always-on service via a forked child process.

## Daemon (`daemon.ts`)

The `Daemon` class spawns the application entry point as a `node:child_process.fork()` child and restarts it on crash.

- Forks `src/index.js` (default) with `["start"]` args; sets `STRATA_DAEMON=1` env var on the child
- Auto-restarts on exit with exponential backoff: `baseDelay * 2^restartCount`, clamped to `maxDelay`
- Defaults: `maxRestarts = 10`, `baseDelay = 1000ms`, `maxDelay = 60000ms`
- Stops retrying once `restartCount >= maxRestarts`
- Graceful shutdown on `SIGTERM`/`SIGINT`: sends `SIGTERM` to child, force-kills with `SIGKILL` after 10 seconds
- `isRunning()` returns current supervisor state; `getRestartCount()` returns cumulative crash count

## Key Files

| File | Purpose |
|------|---------|
| `daemon.ts` | Process supervisor with exponential-backoff restart and signal handling |
