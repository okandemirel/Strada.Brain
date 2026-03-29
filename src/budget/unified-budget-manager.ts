/**
 * Unified Budget Manager
 *
 * Single source of truth for all LLM cost tracking and budget enforcement.
 * Wraps existing DaemonStorage with source-aware cost recording,
 * global daily/monthly limits, and per-source sub-limits.
 */

import { BudgetConfigStore } from "./budget-config-store.js";
import type {
  BudgetSnapshot,
  BudgetSource,
  CostMetadata,
  DailyHistoryEntry,
  UnifiedBudgetConfig,
} from "./budget-types.js";
import { toBudgetUsage } from "./budget-types.js";

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface BudgetEventBus {
  emit(event: string, payload: unknown): void;
}

interface BudgetStorageAdapter {
  insertBudgetEntry(entry: { costUsd: number; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; triggerName?: string | null; timestamp: number; source?: string }): void;
  insertBudgetEntryWithAgent(entry: { costUsd: number; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; triggerName?: string | null; timestamp: number; agentId: string }): void;
  insertBudgetEntryWithSource?(entry: { costUsd: number; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; triggerName?: string | null; timestamp: number; source: string; agentId?: string | null }): void;
  sumBudgetSince(windowStart: number): number;
  sumBudgetBySource(windowStart: number): Record<string, number>;
  sumBudgetForSource(source: string, windowStart: number): number;
  sumBudgetSinceForAgent(windowStart: number, agentId: string): number;
  getDailyHistory(windowStart: number): Array<{ day: string; source: string; total: number }>;
  getBudgetConfig(key: string): string | undefined;
  setBudgetConfig(key: string, value: string): void;
  getAllBudgetConfig(): Record<string, string>;
}

export class UnifiedBudgetManager {
  private readonly storage: BudgetStorageAdapter;
  private readonly configStore: BudgetConfigStore;
  private readonly eventBus: BudgetEventBus;
  private warningEmitted = false;
  private exceededEmitted = false;

  constructor(storage: BudgetStorageAdapter, eventBus: BudgetEventBus) {
    this.storage = storage;
    this.configStore = new BudgetConfigStore(storage);
    this.eventBus = eventBus;
  }

  recordCost(amount: number, source: BudgetSource, metadata: CostMetadata): void {
    if (amount <= 0) return;
    if (source === "agent" && metadata.agentId && this.storage.insertBudgetEntryWithSource) {
      this.storage.insertBudgetEntryWithSource({
        costUsd: amount, model: metadata.model, tokensIn: metadata.tokensIn,
        tokensOut: metadata.tokensOut, triggerName: metadata.triggerName,
        timestamp: Date.now(), source, agentId: metadata.agentId,
      });
    } else if (this.storage.insertBudgetEntryWithSource) {
      this.storage.insertBudgetEntryWithSource({
        costUsd: amount, model: metadata.model, tokensIn: metadata.tokensIn,
        tokensOut: metadata.tokensOut, triggerName: metadata.triggerName,
        timestamp: Date.now(), source,
      });
    } else {
      // Fallback to legacy insert
      this.storage.insertBudgetEntry({
        costUsd: amount, model: metadata.model, tokensIn: metadata.tokensIn,
        tokensOut: metadata.tokensOut, triggerName: metadata.triggerName,
        timestamp: Date.now(), source,
      });
    }
  }

  getSnapshot(): BudgetSnapshot {
    const config = this.configStore.getConfig();
    const now = Date.now();
    const dailyStart = now - ROLLING_WINDOW_MS;
    const monthlyStart = now - MONTHLY_WINDOW_MS;
    const bySource = this.storage.sumBudgetBySource(dailyStart);
    const dailyTotal = Object.values(bySource).reduce((s, v) => s + v, 0);
    const monthlyTotal = this.storage.sumBudgetSince(monthlyStart);

    return {
      global: {
        daily: toBudgetUsage(dailyTotal, config.dailyLimitUsd),
        monthly: toBudgetUsage(monthlyTotal, config.monthlyLimitUsd),
      },
      breakdown: {
        daemon: bySource["daemon"] ?? 0,
        agents: bySource["agent"] ?? 0,
        chat: bySource["chat"] ?? 0,
        verification: bySource["verification"] ?? 0,
      },
      subLimitStatus: {
        daemonExceeded: config.subLimits.daemonDailyUsd > 0 && (bySource["daemon"] ?? 0) >= config.subLimits.daemonDailyUsd,
        agentExceeded: {},
      },
    };
  }

  isGlobalExceeded(): boolean {
    const config = this.configStore.getConfig();
    const now = Date.now();
    if (config.dailyLimitUsd > 0) {
      const dailyUsed = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      if (dailyUsed >= config.dailyLimitUsd) return true;
    }
    if (config.monthlyLimitUsd > 0) {
      const monthlyUsed = this.storage.sumBudgetSince(now - MONTHLY_WINDOW_MS);
      if (monthlyUsed >= config.monthlyLimitUsd) return true;
    }
    return false;
  }

  isSourceExceeded(source: BudgetSource, sourceId?: string): boolean {
    const config = this.configStore.getConfig();
    const dailyStart = Date.now() - ROLLING_WINDOW_MS;
    if (source === "daemon") {
      if (config.subLimits.daemonDailyUsd <= 0) return false;
      return this.storage.sumBudgetForSource("daemon", dailyStart) >= config.subLimits.daemonDailyUsd;
    }
    if (source === "agent" && sourceId) {
      if (config.subLimits.agentDefaultUsd <= 0) return false;
      return this.storage.sumBudgetSinceForAgent(dailyStart, sourceId) >= config.subLimits.agentDefaultUsd;
    }
    return false; // chat and verification have no sub-limits
  }

  canSpend(estimatedCost: number, source: BudgetSource, sourceId?: string): boolean {
    const config = this.configStore.getConfig();
    const now = Date.now();
    if (config.dailyLimitUsd > 0) {
      const used = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      if (used + estimatedCost >= config.dailyLimitUsd) return false;
    }
    if (config.monthlyLimitUsd > 0) {
      const used = this.storage.sumBudgetSince(now - MONTHLY_WINDOW_MS);
      if (used + estimatedCost >= config.monthlyLimitUsd) return false;
    }
    return !this.isSourceExceeded(source, sourceId);
  }

  getDailyHistory(days: number): DailyHistoryEntry[] {
    const windowStart = Date.now() - days * 24 * 60 * 60 * 1000;
    const raw = this.storage.getDailyHistory(windowStart);
    const grouped = new Map<string, { date: string; daemon: number; agents: number; chat: number; verification: number; total: number }>();
    for (const row of raw) {
      const existing = grouped.get(row.day) ?? { date: row.day, daemon: 0, agents: 0, chat: 0, verification: 0, total: 0 };
      const src = row.source ?? "daemon";
      if (src === "daemon") existing.daemon += row.total;
      else if (src === "agent") existing.agents += row.total;
      else if (src === "chat") existing.chat += row.total;
      else if (src === "verification") existing.verification += row.total;
      existing.total += row.total;
      grouped.set(row.day, existing);
    }
    return [...grouped.values()];
  }

  updateConfig(partial: Partial<UnifiedBudgetConfig>): void {
    this.configStore.updateConfig(partial);
    this.warningEmitted = false;
    this.exceededEmitted = false;
    this.eventBus.emit("budget:config_updated", { config: this.configStore.getConfig() });
  }

  getConfig(): UnifiedBudgetConfig { return this.configStore.getConfig(); }

  checkAndEmitEvents(): void {
    const config = this.configStore.getConfig();

    if (config.dailyLimitUsd === 0 && config.monthlyLimitUsd === 0) return;

    const now = Date.now();

    // Check daily limit
    let pct = 0;
    let usedUsd = 0;
    let limitUsd = 0;

    if (config.dailyLimitUsd > 0) {
      usedUsd = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      limitUsd = config.dailyLimitUsd;
      pct = usedUsd / limitUsd;
    }

    // Check monthly limit (use whichever is higher percentage)
    if (config.monthlyLimitUsd > 0) {
      const monthlyUsed = this.storage.sumBudgetSince(now - MONTHLY_WINDOW_MS);
      const monthlyPct = monthlyUsed / config.monthlyLimitUsd;
      if (monthlyPct > pct) {
        pct = monthlyPct;
        usedUsd = monthlyUsed;
        limitUsd = config.monthlyLimitUsd;
      }
    }

    if (pct >= 1.0 && !this.exceededEmitted) {
      this.eventBus.emit("budget:exceeded", { source: "global", pct, usedUsd, limitUsd, isGlobal: true });
      this.exceededEmitted = true;
    } else if (pct < 1.0 && this.exceededEmitted) {
      this.exceededEmitted = false;
      this.warningEmitted = false;
    }

    if (pct >= config.warnPct && !this.warningEmitted && !this.exceededEmitted) {
      this.eventBus.emit("budget:warning", { source: "global", pct, usedUsd, limitUsd });
      this.warningEmitted = true;
    }
  }

  resetWarningFlags(): void {
    this.warningEmitted = false;
    this.exceededEmitted = false;
  }
}
