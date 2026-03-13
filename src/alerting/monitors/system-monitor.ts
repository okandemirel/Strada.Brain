/**
 * System Monitor for Strada.Brain
 * Monitors CPU, memory, disk usage and triggers alerts
 */

import { getAlertManager } from "../alert-manager.js";
import { AlertLevel, MonitorConfig, SystemThresholds } from "../types.js";
import { getLogger } from "../../utils/logger.js";

interface SystemMetrics {
  timestamp: Date;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedGB: number;
  memoryTotalGB: number;
  diskPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  loadAverage: number[];
  uptime: number;
}

interface MonitorState {
  lastAlertTime: Map<string, number>;
  alertCooldownMs: number;
  metrics: SystemMetrics[];
  maxMetricsHistory: number;
}

/**
 * System Monitor class
 */
export class SystemMonitor {
  private config: Required<MonitorConfig>;
  private thresholds: SystemThresholds;
  private state: MonitorState;
  private intervalId?: NodeJS.Timeout;
  private checkInterval: number;

  constructor(
    thresholds: Partial<SystemThresholds> = {},
    checkIntervalMs: number = 60000,
    config: Partial<MonitorConfig> = {},
  ) {
    this.config = {
      enabled: config.enabled ?? true,
      intervalMs: config.intervalMs ?? 60000,
      alertLevel: config.alertLevel ?? "warning",
    };

    this.thresholds = {
      cpuPercent: thresholds.cpuPercent ?? 80,
      memoryPercent: thresholds.memoryPercent ?? 85,
      diskPercent: thresholds.diskPercent ?? 85,
      loadAverage: thresholds.loadAverage ?? 4,
    };

    this.checkInterval = checkIntervalMs;
    this.state = {
      lastAlertTime: new Map(),
      alertCooldownMs: 300000, // 5 minutes between same-type alerts
      metrics: [],
      maxMetricsHistory: 1440, // 24 hours at 1-min intervals
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
    this.check();

    // Schedule periodic checks
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
   * Update thresholds
   */
  updateThresholds(thresholds: Partial<SystemThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Get current thresholds
   */
  getThresholds(): SystemThresholds {
    return { ...this.thresholds };
  }

  /**
   * Perform system check
   */
  async check(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const metrics = await this.collectMetrics();
      this.recordMetrics(metrics);
      await this.checkThresholds(metrics);
    } catch (error) {
      try {
        getLogger().error("[SystemMonitor] Error checking metrics:", error);
      } catch {
        console.error("[SystemMonitor] Error checking metrics:", error);
      }
    }
  }

  /**
   * Collect system metrics
   */
  private async collectMetrics(): Promise<SystemMetrics> {
    const os = await import("os");

    // CPU usage calculation
    const cpuUsage = this.calculateCPUUsage();

    // Memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Disk usage (try multiple methods)
    let diskInfo = { used: 0, total: 1, percent: 0 };
    try {
      diskInfo = await this.getDiskUsage();
    } catch {
      // Fallback
    }

    return {
      timestamp: new Date(),
      cpuPercent: cpuUsage,
      memoryPercent: (usedMem / totalMem) * 100,
      memoryUsedGB: usedMem / 1024 / 1024 / 1024,
      memoryTotalGB: totalMem / 1024 / 1024 / 1024,
      diskPercent: diskInfo.percent,
      diskUsedGB: diskInfo.used / 1024 / 1024 / 1024,
      diskTotalGB: diskInfo.total / 1024 / 1024 / 1024,
      loadAverage: os.loadavg(),
      uptime: os.uptime(),
    };
  }

  /**
   * Calculate CPU usage percentage
   */
  private calculateCPUUsage(): number {
    const os = require("os");
    const cpus = os.cpus();

    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    return 100 - Math.floor((totalIdle / totalTick) * 100);
  }

  /**
   * Get disk usage
   */
  private async getDiskUsage(): Promise<{ used: number; total: number; percent: number }> {
    return new Promise((resolve, reject) => {
      const { exec } = require("child_process");

      // Try df command first
      exec("df -k . | tail -1", (error: Error | null, stdout: string) => {
        if (error) {
          reject(error);
          return;
        }

        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 5) {
          const total = parseInt(parts[1] ?? "0", 10) * 1024;
          const used = parseInt(parts[2] ?? "0", 10) * 1024;
          const percent = parseInt(parts[4]!.replace("%", "") ?? "0", 10);

          resolve({ used, total, percent });
        } else {
          reject(new Error("Unexpected df output format"));
        }
      });
    });
  }

  /**
   * Record metrics to history
   */
  private recordMetrics(metrics: SystemMetrics): void {
    this.state.metrics.push(metrics);

    if (this.state.metrics.length > this.state.maxMetricsHistory) {
      this.state.metrics.shift();
    }
  }

  /**
   * Check metrics against thresholds and send alerts
   */
  private async checkThresholds(metrics: SystemMetrics): Promise<void> {
    // Check CPU
    if (metrics.cpuPercent > this.thresholds.cpuPercent) {
      await this.sendAlertIfNotRateLimited(
        "cpu-high",
        metrics.cpuPercent > 95 ? "critical" : "warning",
        "High CPU Usage",
        `CPU usage is at ${metrics.cpuPercent.toFixed(1)}%, exceeding threshold of ${this.thresholds.cpuPercent}%`,
        { cpuPercent: metrics.cpuPercent, threshold: this.thresholds.cpuPercent },
      );
    }

    // Check Memory
    if (metrics.memoryPercent > this.thresholds.memoryPercent) {
      await this.sendAlertIfNotRateLimited(
        "memory-high",
        metrics.memoryPercent > 95 ? "critical" : "warning",
        "High Memory Usage",
        `Memory usage is at ${metrics.memoryPercent.toFixed(1)}% (${metrics.memoryUsedGB.toFixed(2)} GB / ${metrics.memoryTotalGB.toFixed(2)} GB)`,
        { memoryPercent: metrics.memoryPercent, memoryUsedGB: metrics.memoryUsedGB },
      );
    }

    // Check Disk
    if (metrics.diskPercent > this.thresholds.diskPercent) {
      const level: AlertLevel =
        metrics.diskPercent > 95 ? "critical" : metrics.diskPercent > 90 ? "warning" : "info";

      await this.sendAlertIfNotRateLimited(
        "disk-high",
        level,
        "Low Disk Space",
        `Disk usage is at ${metrics.diskPercent.toFixed(1)}% (${metrics.diskUsedGB.toFixed(2)} GB / ${metrics.diskTotalGB.toFixed(2)} GB)`,
        { diskPercent: metrics.diskPercent, diskUsedGB: metrics.diskUsedGB },
      );
    }

    // Check Load Average (1-min average vs CPU count)
    const os = await import("os");
    const cpuCount = os.cpus().length;
    const loadAverage0 = metrics.loadAverage[0] ?? 0;
    const normalizedLoad = loadAverage0 / cpuCount;

    if (normalizedLoad > this.thresholds.loadAverage) {
      await this.sendAlertIfNotRateLimited(
        "load-high",
        normalizedLoad > this.thresholds.loadAverage * 2 ? "critical" : "warning",
        "High System Load",
        `System load average (1m): ${loadAverage0.toFixed(2)} (normalized: ${normalizedLoad.toFixed(2)})`,
        { loadAverage: metrics.loadAverage, cpuCount },
      );
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
      source: "system-monitor",
      context,
    });
  }

  /**
   * Get current metrics
   */
  getCurrentMetrics(): SystemMetrics | undefined {
    return this.state.metrics[this.state.metrics.length - 1];
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(minutes?: number): SystemMetrics[] {
    if (!minutes) {
      return [...this.state.metrics];
    }

    const cutoff = new Date(Date.now() - minutes * 60000);
    return this.state.metrics.filter((m) => m.timestamp >= cutoff);
  }

  /**
   * Get average metrics over time period
   */
  getAverageMetrics(minutes: number = 5): Partial<SystemMetrics> | null {
    const history = this.getMetricsHistory(minutes);
    if (history.length === 0) return null;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      cpuPercent: avg(history.map((m) => m.cpuPercent)),
      memoryPercent: avg(history.map((m) => m.memoryPercent)),
      diskPercent: avg(history.map((m) => m.diskPercent)),
      loadAverage: [
        avg(history.map((m) => m.loadAverage[0] ?? 0)),
        avg(history.map((m) => m.loadAverage[1] ?? 0)),
        avg(history.map((m) => m.loadAverage[2] ?? 0)),
      ],
    };
  }

  /**
   * Get monitor status
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    thresholds: SystemThresholds;
    currentMetrics?: SystemMetrics;
    metricsCount: number;
  } {
    return {
      running: this.isRunning(),
      enabled: this.config.enabled,
      thresholds: this.getThresholds(),
      currentMetrics: this.getCurrentMetrics(),
      metricsCount: this.state.metrics.length,
    };
  }
}

// Singleton instance
let systemMonitorInstance: SystemMonitor | null = null;

export function getSystemMonitor(
  thresholds?: Partial<SystemThresholds>,
  checkIntervalMs?: number,
): SystemMonitor {
  if (!systemMonitorInstance) {
    systemMonitorInstance = new SystemMonitor(thresholds, checkIntervalMs);
  }
  return systemMonitorInstance;
}

export function resetSystemMonitor(): void {
  systemMonitorInstance?.stop();
  systemMonitorInstance = null;
}
