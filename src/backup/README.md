# src/backup/

Cron-based backup job scheduler with integrity verification and retention management.

## Backup Scheduler (`backup-scheduler.ts` — `BackupScheduler`)

Manages scheduled backup jobs using a built-in cron expression parser and child process execution.

- `Map<string, BackupJob>` stores jobs keyed by 8-character MD5-derived ID
- Persists state to `{backupDir}/scheduler-state.json` as JSON; reloads on construction
- Default backup directory: `/backups/strada-brain`
- Default retention: 30 days; backups verified and compressed by default
- Optional remote sync config supports `s3`, `rclone`, or `none`
- `start()` runs a `setInterval` check loop (default 60,000ms); immediate first check on start
- `executeJob()` spawns child processes via `child_process.spawn` with `BACKUP_DIR` and `RETENTION_DAYS` injected as environment variables
- On success, computes SHA-256 checksum of the latest `backup_*.tar.gz` file
- Failed jobs increment `retryCount` (default max 3 retries)
- `BackupResult[]` history capped at 100 entries
- `verifyBackup()` validates tar.gz integrity via `tar -tzf`
- `cleanupOldBackups()` uses `find -mtime +{retentionDays} -delete` to remove expired backups

## Cron Parser (`backup-scheduler.ts` — `parseCronExpression`)

Standard 5-field cron expression parser (minute, hour, dayOfMonth, month, dayOfWeek).

- Supports: `*` (all), `*/n` (step), `n` (specific), `n-m` (range), `n,m` (list)
- `calculateNextRun()` iterates minute-by-minute up to 525,600 minutes (1 year) to find next match
- `matchesCronPattern()` checks a `Date` against a parsed `CronPattern`

## Predefined Schedules (`Schedule`)

Exported constant object with preset cron strings: `EVERY_MINUTE`, `EVERY_5_MINUTES`, `EVERY_15_MINUTES`, `EVERY_HOUR`, `EVERY_6_HOURS`, `DAILY` (02:00), `DAILY_MORNING` (09:00), `WEEKLY` (Sun 03:00), `MONTHLY` (1st 04:00).

## Singleton Access

- `getBackupScheduler(config?)` returns or creates a singleton `BackupScheduler`
- `resetBackupScheduler()` stops and destroys the singleton

## Key Files

| File | Purpose |
|------|---------|
| `backup-scheduler.ts` | Cron parser, job scheduling, child process execution, integrity verification, retention cleanup |
