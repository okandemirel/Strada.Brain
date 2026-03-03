# src/alerting/

Multi-channel alerting system with four specialized monitors for system health, errors, security events, and backups.

## Alert Manager (`alert-manager.ts`)

Dispatches alerts to up to 8 channels concurrently and tracks delivery statistics.

- Supports Discord (rich embeds), Slack (attachments), Email (HTML via nodemailer), Telegram (Markdown), PagerDuty (v2 Events API), OpsGenie (v2 Alerts API), custom webhooks, and console output
- `Map<string, number>` keyed by `"${level}:${title}"` enforces per-alert-type rate limiting (default 60s cooldown)
- Alert history capped at 1000 entries in a circular buffer (`alertHistory: Alert[]`)
- Alert IDs are 12-char truncated SHA-256 hashes of 16 random bytes
- Level filtering via ordered index comparison: `['info', 'warning', 'critical']`; alerts below `minLevel` are silently dropped
- Discord sends `@everyone` mention on critical alerts; Slack sends `*CRITICAL ALERT*` text
- OpsGenie priority mapping: info=P5, warning=P3, critical=P1
- PagerDuty uses `dedup_key` set to the alert ID
- Email requires `nodemailer` as an optional dependency (dynamic import)
- `AlertStats` tracks `totalAlerts`, counts `byLevel`, counts `byChannel`, `failedSends`, and rolling `averageResponseTime`
- Singleton via `getAlertManager()` / `resetAlertManager()`

## System Monitor (`monitors/system-monitor.ts`)

Polls CPU, memory, disk, and load average on an interval and alerts when thresholds are exceeded.

- Default thresholds: CPU 80%, memory 85%, disk 85%, load average 4 (per-CPU normalized)
- Default check interval: 60s; alert cooldown: 300s (5 min)
- Collects metrics via Node.js `os` module (`cpus()`, `totalmem()`, `freemem()`, `loadavg()`, `uptime()`)
- Disk usage parsed from `df -k . | tail -1` shell command
- CPU usage calculated as `100 - (totalIdle / totalTick * 100)` across all cores
- Metrics history capped at 1440 entries (24 hours at 1-min intervals)
- Escalation: CPU/memory above 95% triggers `critical` instead of `warning`; disk above 95% is `critical`, above 90% is `warning`
- Load average normalized by dividing 1-min average by CPU count; `critical` if normalized load exceeds 2x threshold
- `getAverageMetrics(minutes)` computes mean CPU, memory, disk, and load over the requested window
- Singleton via `getSystemMonitor()` / `resetSystemMonitor()`

## Error Monitor (`monitors/error-monitor.ts`)

Tracks application errors, detects error rate spikes, and monitors consecutive failures.

- Default thresholds: 10 errors/min, 10% error rate, 5 consecutive errors
- Default check interval: 60s; alert cooldown: 300s (5 min)
- Hooks `console.error` at `start()` to automatically capture errors; restores original at `stop()`
- Event buffer capped at 10,000 entries
- `recordError()` increments `consecutiveErrors`; reaching `maxConsecutiveErrors` triggers an immediate `critical` alert
- `trackAPICall(success, endpoint, error)` records errors for failed calls and resets consecutive counter on success
- `trackFunction<T>()` and `trackAsyncFunction<T>()` wrap sync/async functions, recording errors on throw and re-throwing
- Periodic check computes errors-per-minute over a 5-min window; alerts if above `maxErrorsPerMinute`
- Per-source alerting: triggers if any single source exceeds `2 * maxErrorsPerMinute` errors in 5 minutes
- `getStats()` returns `totalErrors`, `errorsBySource` (Map), `errorsByType` (Map by constructor name), `consecutiveErrors`, `errorRateLast5Min`
- Singleton via `getErrorMonitor()` / `resetErrorMonitor()`

## Security Monitor (`monitors/security-monitor.ts`)

Tracks security events, detects brute-force attacks, and manages IP blocking.

- Default thresholds: 5 failed logins/min, 10 suspicious requests/min, 30-min block duration
- Default check interval: 60s; alert cooldown: 300s (5 min); cleanup interval: 600s (10 min)
- 11 event types: `auth_failure`, `unauthorized_access`, `suspicious_request`, `rate_limit_exceeded`, `brute_force_attempt`, `privilege_escalation`, `data_exfiltration`, `injection_attempt`, `xss_attempt`, `csrf_violation`, `session_hijacking`
- Event buffer capped at 10,000 entries
- `Map<string, FailedAuthAttempt[]>` keyed by userId or IP tracks failed auth attempts; entries older than 10 minutes are pruned
- Brute force detection: if failed logins in the last minute reach `maxFailedLoginsPerMinute`, the IP is blocked for 60 minutes
- `Map<string, BlockedEntry>` stores blocked IPs with expiration; `isBlocked(ip)` checks and auto-expires entries
- `recordSuspiciousRequest()` maps attack types to event types: `sql_injection`/`command_injection` -> `injection_attempt` (critical); `xss` -> `xss_attempt` (warning)
- `recordRateLimitExceeded()` auto-blocks IP after 5 rate-limit violations within 5 minutes
- Critical events and brute force attempts trigger immediate alerts via `AlertManager`
- Periodic `checkSuspiciousPatterns()` alerts on IPs exceeding `5 * maxSuspiciousRequestsPerMinute` total events
- `cleanupOldEntries()` prunes auth attempts older than 1 hour, recalculates suspicious IP counts, and removes expired blocks
- Singleton via `getSecurityMonitor()` / `resetSecurityMonitor()`

## Backup Monitor (`monitors/backup-monitor.ts`)

Monitors backup freshness, success rates, and scheduled backup execution.

- Default thresholds: max backup age 25 hours, min success rate 95%
- Default check interval: 300s (5 min); alert cooldown: 3600s (1 hour)
- `BackupRecord` tracks id, timestamp, filename, size, checksum, status (`success` | `failed` | `verifying` | `verified`), error, duration
- Records and verifications capped at 1000 entries each
- `recordBackup()` sends immediate `critical` alert on failure
- `verifyBackup()` checks file existence, runs `tar -tzf` integrity check, and validates SHA-256 checksum against stored value
- `recordVerification()` updates backup status to `verified` or `failed` and alerts on verification failure
- `scanBackups()` reads the backup directory for files matching `backup_YYYYMMDD_HHMMSS.tar.gz`
- `scheduleBackup()` stores cron-based schedules in `Map<string, ScheduledBackup>`; simplified cron parser extracts hour/minute from 5-field expressions
- Periodic checks: backup age (critical if > 2x threshold), success rate over 24h (requires >= 3 backups), missed scheduled backups (alert if > 5 min overdue)
- `getStats(timeWindowHours)` returns totals, success/failure/verified counts, total/average size, and success rate percentage
- Singleton via `getBackupMonitor()` / `resetBackupMonitor()`

## Types (`types.ts`)

Shared type definitions for the alerting system.

- `AlertLevel`: `'info' | 'warning' | 'critical'`
- `AlertChannel`: 8 channel types including `'discord'`, `'slack'`, `'email'`, `'telegram'`, `'pagerDuty'`, `'opsGenie'`, `'customWebhook'`, `'console'`
- `AlertConfig`: channel credentials/URLs, `minLevel`, `rateLimitSeconds`, per-channel enable flags
- `Alert`: id, level, title, message, metadata, timestamp, acknowledgement fields
- `AlertRule`: condition function (sync or async), cooldown, trigger count
- `MonitorConfig`: enabled, intervalMs, alertLevel
- Threshold interfaces: `SystemThresholds` (cpu/memory/disk/load), `ErrorThresholds` (rate/consecutive), `SecurityThresholds` (logins/requests/block duration), `BackupThresholds` (age/success rate)

## Key Files

| File | Purpose |
|------|---------|
| `alert-manager.ts` | Multi-channel alert dispatcher with rate limiting and statistics |
| `types.ts` | Shared interfaces and type definitions |
| `index.ts` | Barrel exports for all alerting components |
| `monitors/system-monitor.ts` | CPU, memory, disk, and load average monitoring |
| `monitors/error-monitor.ts` | Error rate tracking with console.error hook |
| `monitors/security-monitor.ts` | Security event tracking and IP blocking |
| `monitors/backup-monitor.ts` | Backup freshness, verification, and scheduling |
| `monitors/index.ts` | Barrel exports for all monitors |
