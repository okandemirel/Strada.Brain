/**
 * Backup Monitor for Strada.Brain
 * Monitors backup status, verifies integrity, and alerts on failures
 */

import { existsSync, statSync } from "fs";
import { join } from "path";
import { getAlertManager } from "../alert-manager.js";
import { AlertLevel, BackupThresholds, MonitorConfig } from "../types.js";
import { getLogger } from "../../utils/logger.js";

interface BackupRecord {
  id: string;
  timestamp: Date;
  filename: string;
  size: number;
  checksum?: string;
  status: "success" | "failed" | "verifying" | "verified";
  error?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

interface BackupVerification {
  backupId: string;
  verifiedAt: Date;
  checksumValid: boolean;
  filesValid: boolean;
  errors: string[];
}

interface MonitorState {
  backups: BackupRecord[];
  verifications: BackupVerification[];
  maxRecords: number;
  lastAlertTime: Map<string, number>;
  alertCooldownMs: number;
  scheduledBackups: Map<string, ScheduledBackup>;
}

interface ScheduledBackup {
  id: string;
  name: string;
  cronExpression: string;
  enabled: boolean;
  lastRun?: Date;
  nextRun: Date;
  retryCount: number;
}

/**
 * Backup Monitor class
 */
export class BackupMonitor {
  private config: Required<MonitorConfig>;
  private thresholds: BackupThresholds;
  private state: MonitorState;
  private checkInterval: number;
  private intervalId?: NodeJS.Timeout;
  private backupDir: string;

  constructor(
    backupDir: string = "/backups/strada-brain",
    thresholds: Partial<BackupThresholds> = {},
    checkIntervalMs: number = 300000, // 5 minutes
    config: Partial<MonitorConfig> = {},
  ) {
    this.backupDir = backupDir;
    this.config = {
      enabled: config.enabled ?? true,
      intervalMs: config.intervalMs ?? 300000,
      alertLevel: config.alertLevel ?? "warning",
    };

    this.thresholds = {
      maxBackupAgeHours: thresholds.maxBackupAgeHours ?? 25,
      minBackupSuccessRate: thresholds.minBackupSuccessRate ?? 95,
    };

    this.checkInterval = checkIntervalMs;
    this.state = {
      backups: [],
      verifications: [],
      maxRecords: 1000,
      lastAlertTime: new Map(),
      alertCooldownMs: 3600000, // 1 hour
      scheduledBackups: new Map(),
    };
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    // Initial check
    this.scanBackups();

    // Start periodic checks
    this.intervalId = setInterval(() => {
      this.check();
    }, this.checkInterval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Check if monitoring is running
   */
  isRunning(): boolean {
    return !!this.intervalId;
  }

  /**
   * Record a backup attempt
   */
  recordBackup(
    filename: string,
    status: "success" | "failed",
    options: {
      size?: number;
      checksum?: string;
      error?: string;
      duration?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): BackupRecord {
    const record: BackupRecord = {
      id: this.generateBackupId(),
      timestamp: new Date(),
      filename,
      size: options.size || 0,
      checksum: options.checksum,
      status,
      error: options.error,
      duration: options.duration,
      metadata: options.metadata,
    };

    this.state.backups.push(record);

    if (this.state.backups.length > this.state.maxRecords) {
      this.state.backups.shift();
    }

    // Alert on failure
    if (status === "failed") {
      this.sendAlertIfNotRateLimited(
        "backup-failed",
        "critical",
        "Backup Failed",
        `Backup ${filename} failed: ${options.error || "Unknown error"}`,
        { filename, error: options.error },
      );
    }

    return record;
  }

  /**
   * Record backup verification
   */
  recordVerification(
    backupId: string,
    result: {
      checksumValid: boolean;
      filesValid: boolean;
      errors?: string[];
    },
  ): BackupVerification {
    const verification: BackupVerification = {
      backupId,
      verifiedAt: new Date(),
      checksumValid: result.checksumValid,
      filesValid: result.filesValid,
      errors: result.errors || [],
    };

    this.state.verifications.push(verification);

    if (this.state.verifications.length > this.state.maxRecords) {
      this.state.verifications.shift();
    }

    // Update backup status
    const backup = this.state.backups.find((b) => b.id === backupId);
    if (backup) {
      backup.status = result.checksumValid && result.filesValid ? "verified" : "failed";
    }

    // Alert on verification failure
    if (!result.checksumValid || !result.filesValid) {
      this.sendAlertIfNotRateLimited(
        "backup-verification-failed",
        "critical",
        "Backup Verification Failed",
        `Backup ${backupId} verification failed: ${result.errors?.join(", ")}`,
        { backupId, errors: result.errors },
      );
    }

    return verification;
  }

  /**
   * Schedule a backup
   */
  scheduleBackup(
    name: string,
    cronExpression: string,
    options: {
      enabled?: boolean;
      nextRun?: Date;
    } = {},
  ): string {
    const id = `schedule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const scheduled: ScheduledBackup = {
      id,
      name,
      cronExpression,
      enabled: options.enabled ?? true,
      nextRun: options.nextRun || this.calculateNextRun(cronExpression),
      retryCount: 0,
    };

    this.state.scheduledBackups.set(id, scheduled);

    return id;
  }

  /**
   * Unschedule a backup
   */
  unscheduleBackup(id: string): boolean {
    return this.state.scheduledBackups.delete(id);
  }

  /**
   * Scan backup directory for existing backups
   */
  scanBackups(): BackupRecord[] {
    const { readdirSync } = require("fs");
    const newRecords: BackupRecord[] = [];

    try {
      if (!existsSync(this.backupDir)) {
        return [];
      }

      const files = readdirSync(this.backupDir);

      for (const filename of files) {
        if (!filename.match(/^backup_\d{8}_\d{6}\.tar\.gz$/)) {
          continue;
        }

        const filepath = join(this.backupDir, filename);
        const stats = statSync(filepath);

        // Check if already recorded
        const existing = this.state.backups.find((b) => b.filename === filename);
        if (!existing) {
          const record = this.recordBackup(filename, "success", {
            size: stats.size,
          });
          newRecords.push(record);
        }
      }
    } catch (error) {
      try {
        getLogger().error("[BackupMonitor] Error scanning backups:", error);
      } catch {
        console.error("[BackupMonitor] Error scanning backups:", error);
      }
    }

    return newRecords;
  }

  /**
   * Verify a backup file
   */
  async verifyBackup(backupId: string): Promise<BackupVerification> {
    const backup = this.state.backups.find((b) => b.id === backupId);
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    backup.status = "verifying";

    const errors: string[] = [];
    let checksumValid = true;
    let filesValid = true;

    try {
      const filepath = join(this.backupDir, backup.filename);

      // Check file exists
      if (!existsSync(filepath)) {
        errors.push("Backup file not found");
        filesValid = false;
      } else {
        // Verify archive integrity
        const { execSync } = require("child_process");
        try {
          execSync(`tar -tzf "${filepath}" > /dev/null 2>&1`);
        } catch {
          errors.push("Archive integrity check failed");
          filesValid = false;
        }

        // Verify checksum if available
        if (backup.checksum) {
          const checksumFile = `${filepath}.sha256`;
          if (existsSync(checksumFile)) {
            try {
              const calculated = execSync(`sha256sum "${filepath}" | awk '{print \$1}'`)
                .toString()
                .trim();
              if (calculated !== backup.checksum) {
                errors.push("Checksum mismatch");
                checksumValid = false;
              }
            } catch {
              errors.push("Could not verify checksum");
              checksumValid = false;
            }
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      filesValid = false;
    }

    return this.recordVerification(backupId, {
      checksumValid,
      filesValid,
      errors,
    });
  }

  /**
   * Perform periodic checks
   */
  private async check(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      await this.checkBackupAge();
      await this.checkSuccessRate();
      await this.checkScheduledBackups();
    } catch (error) {
      try {
        getLogger().error("[BackupMonitor] Error during check:", error);
      } catch {
        console.error("[BackupMonitor] Error during check:", error);
      }
    }
  }

  /**
   * Check backup age
   */
  private async checkBackupAge(): Promise<void> {
    const recentBackup = this.getMostRecentBackup();

    if (!recentBackup) {
      this.sendAlertIfNotRateLimited(
        "no-backups",
        "critical",
        "No Backups Found",
        "No backups have been recorded. Please check backup configuration.",
        {},
      );
      return;
    }

    const ageHours = (Date.now() - recentBackup.timestamp.getTime()) / (1000 * 60 * 60);

    if (ageHours > this.thresholds.maxBackupAgeHours) {
      const level: AlertLevel =
        ageHours > this.thresholds.maxBackupAgeHours * 2 ? "critical" : "warning";

      this.sendAlertIfNotRateLimited(
        "backup-stale",
        level,
        "Backup Stale",
        `Last successful backup was ${ageHours.toFixed(1)} hours ago (threshold: ${this.thresholds.maxBackupAgeHours} hours)`,
        { lastBackup: recentBackup.timestamp, ageHours },
      );
    }
  }

  /**
   * Check backup success rate
   */
  private async checkSuccessRate(): Promise<void> {
    const last24Hours = this.state.backups.filter(
      (b) => b.timestamp >= new Date(Date.now() - 24 * 60 * 60000),
    );

    if (last24Hours.length < 3) {
      // Not enough backups to calculate meaningful rate
      return;
    }

    const successful = last24Hours.filter((b) => b.status === "success" || b.status === "verified");
    const successRate = (successful.length / last24Hours.length) * 100;

    if (successRate < this.thresholds.minBackupSuccessRate) {
      const failed = last24Hours.filter((b) => b.status === "failed");

      this.sendAlertIfNotRateLimited(
        "low-success-rate",
        "warning",
        "Low Backup Success Rate",
        `Backup success rate is ${successRate.toFixed(1)}% (${successful.length}/${last24Hours.length}) in last 24h, below threshold of ${this.thresholds.minBackupSuccessRate}%`,
        {
          successRate,
          successful: successful.length,
          failed: failed.length,
          total: last24Hours.length,
        },
      );
    }
  }

  /**
   * Check scheduled backups
   */
  private async checkScheduledBackups(): Promise<void> {
    const now = new Date();

    for (const scheduled of this.state.scheduledBackups.values()) {
      if (!scheduled.enabled) continue;

      // Check if missed
      if (scheduled.nextRun < now) {
        const missedBy = (now.getTime() - scheduled.nextRun.getTime()) / 60000;

        if (missedBy > 5) {
          // Alert if missed by more than 5 minutes
          this.sendAlertIfNotRateLimited(
            `missed-backup-${scheduled.id}`,
            "warning",
            "Scheduled Backup Missed",
            `Scheduled backup "${scheduled.name}" was due ${missedBy.toFixed(0)} minutes ago`,
            { scheduleId: scheduled.id, scheduledFor: scheduled.nextRun, missedBy },
          );
        }
      }
    }
  }

  /**
   * Send alert if not rate limited
   */
  private async sendAlertIfNotRateLimited(
    alertKey: string,
    level: AlertLevel,
    title: string,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const lastAlert = this.state.lastAlertTime.get(alertKey);

    if (lastAlert && now - lastAlert < this.state.alertCooldownMs) {
      return;
    }

    this.state.lastAlertTime.set(alertKey, now);

    const alertManager = getAlertManager();
    await alertManager.sendAlert(level, title, message, {
      source: "backup-monitor",
      context,
    });
  }

  /**
   * Calculate next run time from cron expression (simplified)
   */
  private calculateNextRun(cronExpression: string): Date {
    // This is a simplified version - in production use a proper cron parser
    const now = new Date();
    const parts = cronExpression.split(" ");

    if (parts.length === 5) {
      const hour = parseInt(parts[1] ?? "0", 10);
      const minute = parseInt(parts[0] ?? "0", 10);

      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);

      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      return next;
    }

    return new Date(now.getTime() + 24 * 60 * 60000); // Default: tomorrow
  }

  /**
   * Generate backup ID
   */
  private generateBackupId(): string {
    return `backup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get most recent backup
   */
  getMostRecentBackup(): BackupRecord | undefined {
    const sorted = [...this.state.backups]
      .filter((b) => b.status === "success" || b.status === "verified")
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return sorted[0];
  }

  /**
   * Get backup statistics
   */
  getStats(timeWindowHours: number = 24): {
    totalBackups: number;
    successful: number;
    failed: number;
    verified: number;
    totalSize: number;
    averageSize: number;
    successRate: number;
    oldestBackup?: Date;
    newestBackup?: Date;
  } {
    const cutoff = new Date(Date.now() - timeWindowHours * 60 * 60000);
    const recent = this.state.backups.filter((b) => b.timestamp >= cutoff);

    const successful = recent.filter((b) => b.status === "success" || b.status === "verified");
    const failed = recent.filter((b) => b.status === "failed");
    const verified = recent.filter((b) => b.status === "verified");

    const totalSize = recent.reduce((sum, b) => sum + b.size, 0);

    return {
      totalBackups: recent.length,
      successful: successful.length,
      failed: failed.length,
      verified: verified.length,
      totalSize,
      averageSize: recent.length > 0 ? totalSize / recent.length : 0,
      successRate: recent.length > 0 ? (successful.length / recent.length) * 100 : 0,
      oldestBackup: recent[0]?.timestamp,
      newestBackup: recent[recent.length - 1]?.timestamp,
    };
  }

  /**
   * Get recent backups
   */
  getRecentBackups(limit: number = 10): BackupRecord[] {
    return [...this.state.backups]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get scheduled backups
   */
  getScheduledBackups(): ScheduledBackup[] {
    return Array.from(this.state.scheduledBackups.values());
  }

  /**
   * Get monitor status
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    thresholds: BackupThresholds;
    stats: ReturnType<BackupMonitor["getStats"]>;
    scheduledCount: number;
    lastBackup?: BackupRecord;
  } {
    return {
      running: this.isRunning(),
      enabled: this.config.enabled,
      thresholds: { ...this.thresholds },
      stats: this.getStats(),
      scheduledCount: this.state.scheduledBackups.size,
      lastBackup: this.getMostRecentBackup(),
    };
  }

  /**
   * Clear backup history
   */
  clearHistory(): void {
    this.state.backups = [];
    this.state.verifications = [];
  }
}

// Singleton instance
let backupMonitorInstance: BackupMonitor | null = null;

export function getBackupMonitor(
  backupDir?: string,
  thresholds?: Partial<BackupThresholds>,
  checkIntervalMs?: number,
): BackupMonitor {
  if (!backupMonitorInstance) {
    backupMonitorInstance = new BackupMonitor(backupDir, thresholds, checkIntervalMs);
  }
  return backupMonitorInstance;
}

export function resetBackupMonitor(): void {
  backupMonitorInstance?.stop();
  backupMonitorInstance = null;
}
