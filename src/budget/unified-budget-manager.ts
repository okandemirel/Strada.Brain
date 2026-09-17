/**
 * Unified Budget Manager
 *
 * Single source of truth for all LLM cost tracking and budget enforcement.
 * Wraps existing DaemonStorage with source-aware cost recording,
 * global daily/monthly limits, and per-source sub-limits.
 *
 * Reservations (plan 2.12 / audit 03.1 / D20): canSpend() and
 * isGlobalExceeded() used to sum RECORDED spend only, so two runs that
 * started together both passed on the same remaining dollar and the wallet
 * was overspent. A run now reserves an estimate up front; the gates count
 * recorded spend PLUS the unbilled remainder of every in-flight reservation.
 * Shape mirrors AgentBudgetTracker's reserve/settle/release.
 */

import { randomUUID } from "node:crypto";
import { getLoggerSafe } from "../utils/logger.js";
import { BudgetConfigStore } from "./budget-config-store.js";
import type {
  BudgetSnapshot,
  BudgetSource,
  CostMetadata,
  DailyHistoryEntry,
  UnifiedBudgetConfig,
} from "./budget-types.js";
import { DEFAULT_BUDGET_CONFIG, toBudgetUsage } from "./budget-types.js";

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A reservation older than this is treated as leaked and dropped the next
 * time outstanding headroom is read. A background run may legitimately hold
 * one for hours (a campaign sprint), so the ceiling is generous; a leaked one
 * would otherwise shrink the wallet for the life of the process. The drop is
 * logged, never silent (plan 2.12 / audit 03.1 / D20).
 */
export const RESERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** An in-flight commitment against the wallet that has not been recorded yet. */
interface WalletReservation {
  readonly source: BudgetSource;
  readonly sourceId?: string;
  /** Pessimistic up-front estimate of what the reserved work may cost. */
  readonly estimateUsd: number;
  /** Real cost already recorded against this reservation (shrinks it). */
  chargedUsd: number;
  readonly createdAt: number;
}

/** Let a caller's OWN reservation stand aside from a gate it asks on its own behalf. */
export interface BudgetGateOptions {
  readonly ignoreReservationId?: string;
}

interface BudgetEventBus {
  emit(event: string, payload: unknown): void;
}

type BudgetConfigListener = (config: UnifiedBudgetConfig) => void;

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
  private readonly configListeners = new Set<BudgetConfigListener>();
  private readonly env: NodeJS.ProcessEnv;
  /**
   * Outstanding reservations, keyed by reservation id. In-memory by design:
   * a reservation only means "work is in flight in THIS process", and a
   * process that died has no in-flight work to hold headroom for.
   */
  private readonly reservations = new Map<string, WalletReservation>();

  constructor(storage: BudgetStorageAdapter, eventBus: BudgetEventBus, env: NodeJS.ProcessEnv = process.env) {
    this.storage = storage;
    this.configStore = new BudgetConfigStore(storage, env);
    this.eventBus = eventBus;
    this.env = env;
  }

  // ===========================================================================
  // RESERVATIONS (plan 2.12 / audit 03.1 / D20)
  // ===========================================================================

  /**
   * Reserve a pessimistic estimate against the wallet for work about to start.
   * Returns the reservation id; the caller MUST release() it on every exit.
   * A non-positive estimate reserves nothing but still returns an id, so
   * callers keep one unconditional release path.
   */
  reserve(estimateUsd: number, source: BudgetSource, sourceId?: string): string {
    const id = randomUUID();
    this.reservations.set(id, {
      source,
      ...(sourceId ? { sourceId } : {}),
      estimateUsd: Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0,
      chargedUsd: 0,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * Shrink what a reservation still holds by a cost that has been RECORDED.
   * The recorded amount now counts as spend, so the reservation must stop
   * counting it as headroom — used + outstanding stays exact, never doubled.
   * An unknown or released id is a no-op: the cost was still recorded.
   */
  chargeReservation(reservationId: string, costUsd: number): void {
    if (!(costUsd > 0)) return;
    const reservation = this.reservations.get(reservationId);
    if (reservation) reservation.chargedUsd += costUsd;
  }

  /** Drop a reservation without charging anything. Idempotent. */
  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /**
   * Total still reserved (estimate minus what has already been recorded)
   * across in-flight work, optionally narrowed to one source / source id.
   * Reservations past RESERVATION_MAX_AGE_MS are dropped as leaked, with a
   * warning naming how many — never silently.
   */
  outstandingUsd(filter?: { source?: BudgetSource; sourceId?: string; ignoreReservationId?: string }): number {
    const now = Date.now();
    let leaked = 0;
    let outstanding = 0;
    for (const [id, reservation] of this.reservations) {
      if (now - reservation.createdAt > RESERVATION_MAX_AGE_MS) {
        this.reservations.delete(id);
        leaked++;
        continue;
      }
      if (id === filter?.ignoreReservationId) continue;
      if (filter?.source && reservation.source !== filter.source) continue;
      if (filter?.sourceId && reservation.sourceId !== filter.sourceId) continue;
      outstanding += Math.max(0, reservation.estimateUsd - reservation.chargedUsd);
    }
    if (leaked > 0) {
      getLoggerSafe().warn("Dropped leaked budget reservations older than the reservation ceiling", {
        leaked,
        maxAgeMs: RESERVATION_MAX_AGE_MS,
      });
    }
    return outstanding;
  }

  /** Number of reservations currently held (diagnostics / tests). */
  reservationCount(): number {
    return this.reservations.size;
  }

  /**
   * Headroom a task run reserves at start when it carries no estimate of its
   * own: config `taskReservationUsd`, else STRADA_BUDGET_TASK_RESERVATION_USD,
   * else DEFAULT_BUDGET_CONFIG (0.25). 0 disables task reservations.
   */
  getTaskReservationUsd(): number {
    const fromConfig = this.configStore.getConfig().taskReservationUsd;
    if (fromConfig !== undefined && Number.isFinite(fromConfig) && fromConfig >= 0) return fromConfig;
    const fromEnv = Number(this.env["STRADA_BUDGET_TASK_RESERVATION_USD"]);
    if (this.env["STRADA_BUDGET_TASK_RESERVATION_USD"] !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
    return DEFAULT_BUDGET_CONFIG.taskReservationUsd ?? 0;
  }

  /**
   * Subscribe to `budget:config_updated` events. Returns an unsubscribe function.
   * Listeners receive the freshly-resolved config snapshot. Throwing listeners
   * are swallowed to protect the event bus.
   */
  onConfigUpdated(listener: BudgetConfigListener): () => void {
    this.configListeners.add(listener);
    return () => {
      this.configListeners.delete(listener);
    };
  }

  recordCost(amount: number, source: BudgetSource, metadata: CostMetadata): void {
    if (amount <= 0) return;
    // Booked spend stops being reserved headroom (plan 2.12 / D20).
    if (metadata.reservationId) this.chargeReservation(metadata.reservationId, amount);
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

  /**
   * Recorded spend PLUS in-flight reservations against the global limits.
   * `ignoreReservationId` lets a run ask on its own behalf without its own
   * reservation counting against it (plan 2.12 / audit 03.1 / D20).
   */
  isGlobalExceeded(opts?: BudgetGateOptions): boolean {
    const config = this.configStore.getConfig();
    const now = Date.now();
    const outstanding = this.outstandingUsd({ ignoreReservationId: opts?.ignoreReservationId });
    if (config.dailyLimitUsd > 0) {
      const dailyUsed = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      if (dailyUsed + outstanding >= config.dailyLimitUsd) return true;
    }
    if (config.monthlyLimitUsd > 0) {
      const monthlyUsed = this.storage.sumBudgetSince(now - MONTHLY_WINDOW_MS);
      if (monthlyUsed + outstanding >= config.monthlyLimitUsd) return true;
    }
    return false;
  }

  isSourceExceeded(source: BudgetSource, sourceId?: string, opts?: BudgetGateOptions): boolean {
    const config = this.configStore.getConfig();
    const dailyStart = Date.now() - ROLLING_WINDOW_MS;
    const ignoreReservationId = opts?.ignoreReservationId;
    if (source === "daemon") {
      if (config.subLimits.daemonDailyUsd <= 0) return false;
      const outstanding = this.outstandingUsd({ source: "daemon", ignoreReservationId });
      return this.storage.sumBudgetForSource("daemon", dailyStart) + outstanding >= config.subLimits.daemonDailyUsd;
    }
    if (source === "agent" && sourceId) {
      if (config.subLimits.agentDefaultUsd <= 0) return false;
      const outstanding = this.outstandingUsd({ source: "agent", sourceId, ignoreReservationId });
      return this.storage.sumBudgetSinceForAgent(dailyStart, sourceId) + outstanding >= config.subLimits.agentDefaultUsd;
    }
    return false; // chat and verification have no sub-limits
  }

  /**
   * Would `estimatedCost` more fit? Counts recorded spend plus every other
   * in-flight reservation, so two callers cannot both pass on the same
   * remaining dollar. Read-only: the caller reserves once it decides to run.
   */
  canSpend(estimatedCost: number, source: BudgetSource, sourceId?: string, opts?: BudgetGateOptions): boolean {
    const config = this.configStore.getConfig();
    const now = Date.now();
    const outstanding = this.outstandingUsd({ ignoreReservationId: opts?.ignoreReservationId });
    if (config.dailyLimitUsd > 0) {
      const used = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      if (used + outstanding + estimatedCost >= config.dailyLimitUsd) return false;
    }
    if (config.monthlyLimitUsd > 0) {
      const used = this.storage.sumBudgetSince(now - MONTHLY_WINDOW_MS);
      if (used + outstanding + estimatedCost >= config.monthlyLimitUsd) return false;
    }
    return !this.isSourceExceeded(source, sourceId, opts);
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
    const fresh = this.configStore.getConfig();
    this.eventBus.emit("budget:config_updated", { config: fresh });
    for (const listener of this.configListeners) {
      try {
        listener(fresh);
      } catch {
        // swallow — listener errors must not break the update path
      }
    }
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

    // Spend is a SLIDING 24h window, so pct falls on its own without ever
    // reaching 1.0 — and the only reset above requires the exceeded latch to
    // have fired first. The warning therefore fired once per process lifetime;
    // an unattended daemon's second climb to 0.95 was silent until the hard
    // stop (audited 2026-09-02). Re-arm on every drop below the threshold so
    // the warning is edge-triggered per crossing.
    if (pct < config.warnPct) this.warningEmitted = false;

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
