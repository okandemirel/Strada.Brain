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
  BudgetEstimates,
  BudgetSource,
  CostMetadata,
  DailyHistoryEntry,
  UnifiedBudgetConfig,
} from "./budget-types.js";
import { DEFAULT_BUDGET_CONFIG, toBudgetUsage, hasBudgetLimit } from "./budget-types.js";

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Ignore floating point addition noise without rounding the recorded dollars. */
function exceedsLimit(total: number, limit: number): boolean {
  const roundoff = Math.min(1e-9, Number.EPSILON * Math.max(1, Math.abs(total), Math.abs(limit)) * 4);
  return total - limit > roundoff;
}

/** Legacy diagnostic threshold. Age alone never releases uncertain liability. */
export const RESERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** An in-flight commitment against the wallet that has not been recorded yet. */
interface WalletReservation {
  readonly source: BudgetSource;
  readonly sourceId?: string;
  /** Pessimistic up-front estimate of what the reserved work may cost. */
  readonly estimateUsd: number;
  /** Real cost already recorded against this reservation (shrinks it). */
  chargedUsd: number;
  /** When it last booked an evidenced cost. */
  lastActivityAt?: number;
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
  budgetTransaction?<T>(work: () => T): T;
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
  // Read-only legacy adapters remain supported; durable admission requires all wallet operations.
  upsertBudgetReservation?(row: { id: string; source: string; sourceId?: string | null; estimateUsd: number; chargedUsd: number; ownerPid: number; ownerGeneration?: string | null; createdAt: number; lastActivityAt?: number | null }): void;
  chargeBudgetReservation?(id: string, chargedUsd: number, lastActivityAt: number): void;
  deleteBudgetReservation?(id: string): void;
  reconcileBudgetReservation?(id: string, now: number): boolean;
  listBudgetReservations?(): Array<{ id: string; source: string; sourceId: string | null; estimateUsd: number; chargedUsd: number; ownerPid: number; ownerGeneration?: string | null; createdAt: number; lastActivityAt: number | null; reconciledAt?: number | null }>;
}

export interface BudgetProcessIdentity {
  readonly pid: number;
  readonly generation: string;
}

// One unpredictable generation per Node process, shared by all its managers.
const PROCESS_IDENTITY: BudgetProcessIdentity = { pid: process.pid, generation: randomUUID() };

interface BudgetProcessOptions {
  readonly identity?: BudgetProcessIdentity;
  /** Optional trusted generation-aware liveness probe. PID existence alone is insufficient. */
  readonly isOwnerAlive?: (owner: BudgetProcessIdentity) => boolean;
}

/** Recovery can run at boot, on demand, and before admission. */
export interface ReservationReconciliation {
  /** Newly recovered reservations whose owner generation could not be verified alive. */
  readonly orphans: number;
  /** Compatibility field: always zero, since recovery cannot establish provider spend. */
  readonly bookedUsd: number;
  /** Uncertain remainder retained as an estimate, never a provider charge. */
  readonly estimatedUsd?: number;
}

export class UnifiedBudgetManager {
  private readonly storage: BudgetStorageAdapter;
  private readonly configStore: BudgetConfigStore;
  private readonly eventBus: BudgetEventBus;
  private warningEmitted = false;
  private exceededEmitted = false;
  private readonly configListeners = new Set<BudgetConfigListener>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly identity: BudgetProcessIdentity;
  private readonly isOwnerAlive: (owner: BudgetProcessIdentity) => boolean;
  /** Local run handles only. SQLite is authoritative for wallet liability. */
  private readonly reservations = new Map<string, WalletReservation>();

  constructor(storage: BudgetStorageAdapter, eventBus: BudgetEventBus, env: NodeJS.ProcessEnv = process.env, processOptions: BudgetProcessOptions = {}) {
    this.storage = storage;
    this.configStore = new BudgetConfigStore(storage, env);
    this.eventBus = eventBus;
    this.env = env;
    this.identity = processOptions.identity ?? PROCESS_IDENTITY;
    // Foreign generations cannot be proved alive by a PID probe. Conservatively
    // label their remainder an estimate; it stays payable headroom until resolved.
    this.isOwnerAlive = processOptions.isOwnerAlive ?? ((owner) =>
      owner.pid === this.identity.pid && owner.generation === this.identity.generation);
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
    const createdAt = Date.now();
    const amount = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
    const reservation = {
      source,
      ...(sourceId ? { sourceId } : {}),
      estimateUsd: amount,
      chargedUsd: 0,
      createdAt,
    };
    // THE LIABILITY IS WRITTEN BEFORE THE WORK IS DISPATCHED (round 8 #2):
    // a crash between the provider's charge and the usage callback used to
    // leave the wallet with neither the reservation nor the spend.
    if (!this.storage.upsertBudgetReservation) throw new Error("Durable budget reservations are unavailable");
    this.storage.upsertBudgetReservation({
      id, source, sourceId: sourceId ?? null, estimateUsd: amount, chargedUsd: 0,
      ownerPid: this.identity.pid, ownerGeneration: this.identity.generation, createdAt, lastActivityAt: null,
    });
    this.reservations.set(id, reservation);
    return id;
  }

  /** Release errors retain durable headroom and can be retried safely. */
  private persist(write: () => void, what: string): void {
    try {
      write();
    } catch (error) {
      getLoggerSafe().warn("Could not release a budget reservation; durable liability remains", {
        action: what,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (!reservation) return;
    const charged = reservation.chargedUsd + costUsd;
    const now = Date.now();
    this.storage.chargeBudgetReservation?.(reservationId, charged, now);
    reservation.chargedUsd = charged;
    reservation.lastActivityAt = now;
  }

  /** Drop a reservation without charging anything. Idempotent. */
  release(reservationId: string): void {
    this.reservations.delete(reservationId);
    // Released in this process: there is no liability left to reconcile.
    this.persist(() => this.storage.deleteBudgetReservation?.(reservationId), "release");
  }

  /**
   * Total still reserved (estimate minus what has already been recorded)
   * across in-flight work, optionally narrowed to one source / source id.
   * All durable remainders count, regardless of owner or age.
   */
  outstandingUsd(filter?: { source?: BudgetSource; sourceId?: string; ignoreReservationId?: string; since?: number }): number {
    const durable = this.storage.listBudgetReservations?.();
    const rows = durable ?? [...this.reservations].map(([id, row]) => ({ id, ...row }));
    let outstanding = 0;
    for (const reservation of rows) {
      if (reservation.id === filter?.ignoreReservationId) continue;
      if (filter?.source && reservation.source !== filter.source) continue;
      if (filter?.sourceId && reservation.sourceId !== filter.sourceId) continue;
      // A RECONCILED LIABILITY BELONGS TO THE WINDOW IT AROSE IN.
      //
      // Work still in flight holds its headroom however long it runs — a
      // campaign sprint may reserve for hours, and its owner is alive. But a
      // reservation whose owner is GONE has been resolved as far as it ever
      // will be: it is an estimate of what some dead run may have spent, on
      // the day it died. A rolling-window gate asks "what was spent in the
      // last 24 hours"; a crash from last week cannot answer that, and
      // counting it there starved today's wallet permanently, one crash at a
      // time, with no operator path back. It stays visible as an estimate
      // (getSnapshot().estimates) either way.
      const reconciledAt = (reservation as { reconciledAt?: number | null }).reconciledAt;
      if (filter?.since !== undefined && reconciledAt != null) {
        const arose = reservation.lastActivityAt ?? reservation.createdAt;
        if (typeof arose === "number" && arose < filter.since) continue;
      }
      outstanding += Math.max(0, reservation.estimateUsd - reservation.chargedUsd);
    }
    return outstanding;
  }

  /**
   * CHECK AND RESERVE IN ONE STEP, or refuse. Reserving without asking let two
   * runs start on the same remaining dollar: nothing in production called
   * canSpend, so the reservations recorded the overcommitment instead of
   * preventing it (Codex round 8 #1). Returns the reservation id, or undefined
   * when the wallet cannot carry the estimate — the caller must not run.
   */
  reserveIfAffordable(estimateUsd: number, source: BudgetSource, sourceId?: string): string | undefined {
    let pendingId: string | undefined;
    try {
      if (!this.storage.budgetTransaction || !this.storage.upsertBudgetReservation || !this.storage.listBudgetReservations || !this.storage.chargeBudgetReservation || !this.storage.reconcileBudgetReservation) {
        return undefined;
      }
      this.reconcileOrphanedReservations();
      return this.transaction(() => {
        if (!this.canSpend(estimateUsd, source, sourceId)) return undefined;
        pendingId = this.reserve(estimateUsd, source, sourceId);
        return pendingId;
      });
    } catch (error) {
      if (pendingId) this.reservations.delete(pendingId);
      getLoggerSafe().warn("Budget admission could not be persisted", { error });
      return undefined;
    }
  }

  /** Number of reservations currently held (diagnostics / tests). */
  reservationCount(): number {
    return this.reservations.size;
  }

  /**
   * Atomically mark unverified/dead owner remainders as estimates. They remain
   * in reservations (with their source/agent identity), never in the cost ledger.
   * Liveness checks happen outside the writer transaction; the claim rechecks
   * identity and state so stale lists cannot recover a row twice.
   */
  reconcileOrphanedReservations(): ReservationReconciliation {
    const rows = this.storage.listBudgetReservations?.();
    if (!rows || rows.length === 0) return { orphans: 0, bookedUsd: 0 };
    let orphans = 0;
    let estimatedUsd = 0;
    for (const candidate of rows) {
      if (candidate.reconciledAt != null) continue;
      if (candidate.ownerGeneration && this.isOwnerAlive({ pid: candidate.ownerPid, generation: candidate.ownerGeneration })) continue;
      const recovered = this.transaction(() => {
        const row = this.storage.listBudgetReservations?.().find((r) => r.id === candidate.id);
        if (!row || row.ownerPid !== candidate.ownerPid || row.ownerGeneration !== candidate.ownerGeneration) return undefined;
        if (row.reconciledAt != null || !this.storage.reconcileBudgetReservation?.(row.id, Date.now())) return undefined;
        const unbilled = Math.max(0, row.estimateUsd - row.chargedUsd);
        return unbilled;
      });
      if (recovered !== undefined) { orphans++; estimatedUsd += recovered; }
    }
    if (orphans > 0) {
      getLoggerSafe().warn("Retained orphaned reservation remainders as uncertain estimates", {
        orphans,
        estimatedUsd: Number(estimatedUsd.toFixed(4)),
      });
    }
    return { orphans, bookedUsd: 0, ...(orphans > 0 ? { estimatedUsd } : {}) };
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
    const now = Date.now();
    this.transaction(() => {
      const entry = {
        costUsd: amount, model: metadata.model, tokensIn: metadata.tokensIn,
        tokensOut: metadata.tokensOut, triggerName: metadata.triggerName,
        timestamp: now, source, agentId: source === "agent" ? metadata.agentId : undefined,
      };
      if (this.storage.insertBudgetEntryWithSource) this.storage.insertBudgetEntryWithSource(entry);
      else this.storage.insertBudgetEntry(entry);
      if (metadata.reservationId) {
        const row = this.storage.listBudgetReservations?.().find((r) => r.id === metadata.reservationId);
        if (row) this.storage.chargeBudgetReservation?.(row.id, row.chargedUsd + amount, now);
      }
    });
    // Publish in-memory progress only after the SQLite commit succeeds.
    const reservation = metadata.reservationId ? this.reservations.get(metadata.reservationId) : undefined;
    if (reservation) {
      reservation.chargedUsd += amount;
      reservation.lastActivityAt = now;
    }
  }

  private transaction<T>(work: () => T): T {
    return this.storage.budgetTransaction ? this.storage.budgetTransaction(work) : work();
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
      estimates: this.getEstimates(),
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

  private getEstimates(): BudgetEstimates {
    const rows = this.storage.listBudgetReservations?.() ?? [...this.reservations.values()];
    const bySource: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    let outstandingUsd = 0;
    let reconciledUsd = 0;
    for (const row of rows) {
      const amount = Math.max(0, row.estimateUsd - row.chargedUsd);
      outstandingUsd += amount;
      if ("reconciledAt" in row && row.reconciledAt != null) reconciledUsd += amount;
      bySource[row.source] = (bySource[row.source] ?? 0) + amount;
      if (row.source === "agent" && row.sourceId) byAgent[row.sourceId] = (byAgent[row.sourceId] ?? 0) + amount;
    }
    return { kind: "estimate", outstandingUsd, reconciledUsd, bySource, byAgent };
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
    if (hasBudgetLimit(config.dailyLimitUsd)) {
      const dailyUsed = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      if (dailyUsed + outstanding >= config.dailyLimitUsd) return true;
    }
    if (hasBudgetLimit(config.monthlyLimitUsd)) {
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
    const dailyStart = now - ROLLING_WINDOW_MS;
    const monthlyStart = now - MONTHLY_WINDOW_MS;
    if (hasBudgetLimit(config.dailyLimitUsd)) {
      const used = this.storage.sumBudgetSince(dailyStart);
      const outstanding = this.outstandingUsd({ ignoreReservationId: opts?.ignoreReservationId, since: dailyStart });
      if (config.dailyLimitUsd === 0 || exceedsLimit(used + outstanding + estimatedCost, config.dailyLimitUsd)) return false;
    }
    if (hasBudgetLimit(config.monthlyLimitUsd)) {
      const used = this.storage.sumBudgetSince(monthlyStart);
      const outstanding = this.outstandingUsd({ ignoreReservationId: opts?.ignoreReservationId, since: monthlyStart });
      if (config.monthlyLimitUsd === 0 || exceedsLimit(used + outstanding + estimatedCost, config.monthlyLimitUsd)) return false;
    }
    const pending = this.outstandingUsd({ source, sourceId, ignoreReservationId: opts?.ignoreReservationId, since: dailyStart });
    if (source === "daemon" && config.subLimits.daemonDailyUsd > 0) {
      return !exceedsLimit(this.storage.sumBudgetForSource(source, dailyStart) + pending + estimatedCost, config.subLimits.daemonDailyUsd);
    }
    if (source === "agent" && sourceId && config.subLimits.agentDefaultUsd > 0) {
      return !exceedsLimit(this.storage.sumBudgetSinceForAgent(dailyStart, sourceId) + pending + estimatedCost, config.subLimits.agentDefaultUsd);
    }
    return true;
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

    // No ceiling at all: nothing to warn about. A ceiling of ZERO is a real
    // ceiling and its events fire (plan 2.1b).
    if (!hasBudgetLimit(config.dailyLimitUsd) && !hasBudgetLimit(config.monthlyLimitUsd)) return;

    const now = Date.now();

    // Check daily limit
    let pct = 0;
    let usedUsd = 0;
    let limitUsd = 0;

    if (hasBudgetLimit(config.dailyLimitUsd)) {
      usedUsd = this.storage.sumBudgetSince(now - ROLLING_WINDOW_MS);
      limitUsd = config.dailyLimitUsd;
      pct = usedUsd / limitUsd;
    }

    // Check monthly limit (use whichever is higher percentage)
    if (hasBudgetLimit(config.monthlyLimitUsd)) {
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
