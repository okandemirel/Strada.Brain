/**
 * DigestReporter -- Periodic summary delivery with delta tracking.
 *
 * Collects snapshot data from MetricsStorage, LearningStorage, HeartbeatLoop,
 * and BudgetTracker at send time. Formats as structured markdown via DigestFormatter.
 * Delivers via IChannelSender with channel-aware truncation. Tracks deltas in
 * DaemonStorage for "+N since last digest" display.
 *
 * Lifecycle: start() creates cron job, stop() disposes it. sendDigest() can
 * also be called directly for CLI-triggered immediate digests.
 *
 * Requirements: RPT-01
 */

import { Cron } from "croner";
import type { DaemonStorage } from "../daemon-storage.js";
import type { DaemonEventMap } from "../daemon-events.js";
import type { IEventBus } from "../../core/event-bus.js";
import type { IChannelSender } from "../../channels/channel-core.interface.js";
import type { DigestConfig } from "./notification-types.js";
import {
  formatDigest,
  truncateForChannel,
  type DigestSnapshot,
  type DigestDeltas,
} from "./digest-formatter.js";
import type * as winston from "winston";

// =============================================================================
// TYPES
// =============================================================================

export interface DigestReporterDeps {
  readonly config: DigestConfig;
  readonly daemonConfig: { timezone: string };
  readonly storage: DaemonStorage;
  readonly channelSender?: IChannelSender;
  readonly chatId?: string;
  readonly channelType?: string;
  readonly eventBus: IEventBus<DaemonEventMap>;
  readonly metricsStorage?: {
    getAggregation(filter: Record<string, unknown>): {
      totalTasks: number;
      successCount: number;
      failureCount: number;
      completionRate: number;
    };
  };
  readonly learningStorage?: {
    getStats(): {
      instinctCount: number;
      activeInstinctCount: number;
    };
  };
  readonly budgetTracker?: {
    getUsage(): { usedUsd: number; limitUsd: number | undefined };
  };
  readonly dashboardPort?: number;
  readonly logger: winston.Logger;
}

// =============================================================================
// DIGEST REPORTER
// =============================================================================

export class DigestReporter {
  private readonly deps: DigestReporterDeps;
  private cronJob: Cron | null = null;

  constructor(deps: DigestReporterDeps) {
    this.deps = deps;
  }

  /**
   * Start the cron-scheduled digest.
   * If config.enabled is false, does nothing.
   * Per discretion: waits for cron schedule, does not send immediately on startup.
   */
  start(): void {
    if (!this.deps.config.enabled) return;

    const tz = this.deps.config.timezone || this.deps.daemonConfig.timezone || undefined;

    this.cronJob = new Cron(
      this.deps.config.schedule,
      { timezone: tz },
      () => { void this.sendDigest(); },
    );
  }

  /**
   * Send a digest immediately. Called by cron schedule and by CLI command.
   *
   * Steps:
   * 1. Gather snapshot data from available deps
   * 2. Read previous deltas from storage
   * 3. Calculate deltas
   * 4. Format markdown
   * 5. Deliver via channel (if available)
   * 6. Update delta state in storage
   * 7. Emit daemon:digest_sent event
   */
  async sendDigest(): Promise<string> {
    const now = Date.now();
    const dashboardUrl = `http://localhost:${this.deps.dashboardPort ?? 3100}`;

    // 1. Gather snapshot
    const snapshot = this.gatherSnapshot(dashboardUrl);

    // 2. Read previous state and calculate deltas
    const deltas = this.calculateDeltas(snapshot);

    // 3. Format markdown
    const markdown = formatDigest(snapshot, deltas);

    // 4. Deliver via channel
    let truncated = false;
    if (this.deps.channelSender && this.deps.chatId) {
      const channelType = this.deps.channelType ?? "web";
      const finalMarkdown = truncateForChannel(markdown, channelType, dashboardUrl);
      truncated = finalMarkdown.length < markdown.length;

      try {
        await this.deps.channelSender.sendMarkdown(this.deps.chatId, finalMarkdown);
      } catch (err) {
        this.deps.logger.error("Failed to send digest", { error: err });
      }
    } else {
      this.deps.logger.warn("No channel available for digest delivery -- skipping");
    }

    // 5. Update delta state
    this.updateDigestState(snapshot, now);

    // 6. Emit event
    const sectionCount = this.countSections(snapshot);
    this.deps.eventBus.emit("daemon:digest_sent", {
      channelType: this.deps.channelType ?? "none",
      sectionCount,
      truncated,
      timestamp: now,
    });

    return markdown;
  }

  /**
   * Stop the cron job.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * Get the timestamp of the last sent digest from storage.
   */
  getLastDigestTime(): number | undefined {
    const val = this.deps.storage.getDaemonState("digest_last_timestamp");
    return val ? Number(val) : undefined;
  }

  // =========================================================================
  // PRIVATE: Data Gathering
  // =========================================================================

  private gatherSnapshot(dashboardUrl: string): DigestSnapshot {
    // Metrics data
    let tasksCompleted = 0;
    let tasksFailed = 0;
    if (this.deps.metricsStorage) {
      try {
        const agg = this.deps.metricsStorage.getAggregation({});
        tasksCompleted = agg.successCount;
        tasksFailed = agg.failureCount;
      } catch {
        // Metrics unavailable -- skip
      }
    }

    // Learning data
    let instinctsLearned = 0;
    let instinctsPromoted = 0;
    let totalActiveInstincts = 0;
    if (this.deps.learningStorage) {
      try {
        const stats = this.deps.learningStorage.getStats();
        totalActiveInstincts = stats.activeInstinctCount;
        instinctsLearned = stats.instinctCount;
      } catch {
        // Learning unavailable -- skip
      }
    }

    // Budget data
    let budgetUsed: number | null = null;
    let budgetLimit: number | null = null;
    if (this.deps.budgetTracker) {
      try {
        const usage = this.deps.budgetTracker.getUsage();
        budgetUsed = usage.usedUsd;
        budgetLimit = usage.limitUsd ?? null;
      } catch {
        // Budget unavailable -- skip
      }
    }

    // Trigger and error data (gathered from storage if available in future phases)
    const triggers: Array<{ name: string; fireCount: number; lastResult: string }> = [];
    const errors: Array<{ message: string; timestamp: number }> = [];

    return {
      errors,
      triggers,
      tasksCompleted,
      tasksFailed,
      instinctsLearned,
      instinctsPromoted,
      totalActiveInstincts,
      budgetUsed,
      budgetLimit,
      goalProgress: null,
      dashboardUrl,
    };
  }

  private calculateDeltas(snapshot: DigestSnapshot): DigestDeltas {
    const lastTimestamp = this.deps.storage.getDaemonState("digest_last_timestamp");
    const lastTasksCompleted = this.deps.storage.getDaemonState("digest_last_tasks_completed");
    const lastActiveInstincts = this.deps.storage.getDaemonState("digest_last_active_instincts");
    const lastBudgetUsed = this.deps.storage.getDaemonState("digest_last_budget_used");

    const deltas: {
      triggerDelta?: number;
      taskDelta?: number;
      instinctDelta?: number;
      budgetDelta?: number;
      lastDigestTime?: number;
    } = {};

    if (lastTimestamp) {
      deltas.lastDigestTime = Number(lastTimestamp);
    }

    if (lastTasksCompleted !== undefined) {
      const prevTotal = Number(lastTasksCompleted);
      const currentTotal = snapshot.tasksCompleted + snapshot.tasksFailed;
      if (currentTotal > prevTotal) {
        deltas.taskDelta = currentTotal - prevTotal;
      }
    }

    if (lastActiveInstincts !== undefined) {
      const prev = Number(lastActiveInstincts);
      if (snapshot.totalActiveInstincts > prev) {
        deltas.instinctDelta = snapshot.totalActiveInstincts - prev;
      }
    }

    if (lastBudgetUsed !== undefined && snapshot.budgetUsed !== null) {
      const prev = Number(lastBudgetUsed);
      if (snapshot.budgetUsed > prev) {
        deltas.budgetDelta = Number((snapshot.budgetUsed - prev).toFixed(2));
      }
    }

    return deltas;
  }

  private updateDigestState(snapshot: DigestSnapshot, timestamp: number): void {
    this.deps.storage.setDaemonState("digest_last_timestamp", String(timestamp));
    this.deps.storage.setDaemonState(
      "digest_last_tasks_completed",
      String(snapshot.tasksCompleted + snapshot.tasksFailed),
    );
    this.deps.storage.setDaemonState(
      "digest_last_active_instincts",
      String(snapshot.totalActiveInstincts),
    );
    if (snapshot.budgetUsed !== null) {
      this.deps.storage.setDaemonState(
        "digest_last_budget_used",
        String(snapshot.budgetUsed),
      );
    }
  }

  private countSections(snapshot: DigestSnapshot): number {
    let count = 0;
    if (snapshot.errors.length > 0) count++;
    if (snapshot.triggers.length > 0) count++;
    if (snapshot.tasksCompleted > 0 || snapshot.tasksFailed > 0) count++;
    if (snapshot.instinctsLearned > 0 || snapshot.instinctsPromoted > 0 || snapshot.totalActiveInstincts > 0) count++;
    if (snapshot.budgetUsed !== null) count++;
    if (snapshot.goalProgress !== null) count++;
    return count;
  }
}
