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
import { hostname } from "node:os";
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

/**
 * How recently a registered owner must have heartbeat to be PROVEN alive
 * (round 10 #7). A stale heartbeat proves nothing on its own — a working
 * process can be busy, wedged, or merely idle — so it only sends the question
 * on to the PID probe, whose "not running" is the proof.
 */
export const OWNER_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

/** Registrations nobody has refreshed for this long are dropped, bounding the registry. */
const OWNER_REGISTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What we can honestly say about the process that owns a reservation. */
type OwnerVerdict = "alive" | "dead" | "unknown";

/**
 * Is this PID occupied by SOME process? Signal 0 delivers nothing; EPERM means
 * it exists but belongs to another user. Anything else (ESRCH) means gone.
 * A running PID does not identify WHICH process holds it — that is what the
 * generation registry is for.
 */
function pidIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
  insertBudgetEntryWithSource?(entry: { costUsd: number; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; triggerName?: string | null; timestamp: number; source: string; agentId?: string | null; taskId?: string | null; campaignId?: string | null }): void;
  sumBudgetSince(windowStart: number): number;
  sumBudgetBySource(windowStart: number): Record<string, number>;
  sumBudgetForSource(source: string, windowStart: number): number;
  sumBudgetSinceForAgent(windowStart: number, agentId: string): number;
  getDailyHistory(windowStart: number): Array<{ day: string; source: string; total: number }>;
  getBudgetConfig(key: string): string | undefined;
  setBudgetConfig(key: string, value: string): void;
  getAllBudgetConfig(): Record<string, string>;
  // Read-only legacy adapters remain supported; durable admission requires all wallet operations.
  upsertBudgetReservation?(row: { id: string; source: string; sourceId?: string | null; estimateUsd: number; chargedUsd: number; ownerPid: number; ownerGeneration?: string | null; ownerHost?: string | null; createdAt: number; lastActivityAt?: number | null }): void;
  chargeBudgetReservation?(id: string, chargedUsd: number, lastActivityAt: number): void;
  deleteBudgetReservation?(id: string): void;
  reconcileBudgetReservation?(id: string, now: number): boolean;
  listBudgetReservations?(): Array<{ id: string; source: string; sourceId: string | null; estimateUsd: number; chargedUsd: number; ownerPid: number; ownerGeneration?: string | null; ownerHost?: string | null; createdAt: number; claimSeq?: number | null; lastActivityAt: number | null; reconciledAt?: number | null }>;
  // Owner liveness registry (round 10 #7). Absent on legacy adapters: without
  // it no foreign owner can be proved ALIVE, and none can be proved dead
  // either unless its PID is gone — uncertainty keeps its headroom.
  touchBudgetOwner?(ownerPid: number, ownerGeneration: string, now: number, ownerHost?: string): void;
  listBudgetOwners?(): Array<{ ownerPid: number; ownerGeneration: string; heartbeatAt: number; registeredAt?: number; registeredSeq?: number; ownerHost?: string }>;
  pruneBudgetOwners?(heartbeatBefore: number): void;
}

/** One registry row, looked up by (host, pid). */
type OwnerRegistry = Map<
  string,
  { generation: string; heartbeatAt: number; registeredAt?: number; registeredSeq?: number; host?: string }
>;

export interface BudgetProcessIdentity {
  readonly pid: number;
  readonly generation: string;
  /**
   * WHOSE PID THIS IS (Codex round 12 #2). Two machines can share one wallet,
   * and pid 123 on another host is a different process — its registry row
   * says nothing about ours, and `process.kill(123, 0)` here answers about
   * OUR pid 123. Absent means "this host", which is exactly how every
   * single-machine install behaved before the column existed.
   */
  readonly host?: string;
}

// One unpredictable generation per Node process, shared by all its managers.
const PROCESS_IDENTITY: BudgetProcessIdentity = { pid: process.pid, generation: randomUUID(), host: hostname() };

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
  /** Trusted external probe. Absent in production: the registry below answers instead. */
  private readonly injectedIsOwnerAlive?: (owner: BudgetProcessIdentity) => boolean;
  /** Local run handles only. SQLite is authoritative for wallet liability. */
  private readonly reservations = new Map<string, WalletReservation>();

  constructor(storage: BudgetStorageAdapter, eventBus: BudgetEventBus, env: NodeJS.ProcessEnv = process.env, processOptions: BudgetProcessOptions = {}) {
    this.storage = storage;
    this.configStore = new BudgetConfigStore(storage, env);
    this.eventBus = eventBus;
    this.env = env;
    this.identity = processOptions.identity ?? PROCESS_IDENTITY;
    // Production supplies no probe: ownerVerdict() decides from the durable
    // owner registry plus a PID probe, and UNKNOWN keeps its headroom.
    this.injectedIsOwnerAlive = processOptions.isOwnerAlive;
    this.heartbeat();
  }

  // ===========================================================================
  // OWNER LIVENESS (round 10 #7)
  // ===========================================================================

  /**
   * Publish "this process incarnation still holds the wallet". Called on every
   * path that commits liability, so a working process keeps proving itself
   * alive to the OTHER processes sharing this wallet. Best effort: a failed
   * heartbeat only downgrades this process from ALIVE to UNKNOWN elsewhere,
   * and UNKNOWN keeps its headroom.
   */
  heartbeat(): void {
    if (!this.storage.touchBudgetOwner) return;
    this.persist(() => this.storage.touchBudgetOwner?.(this.identity.pid, this.identity.generation, Date.now(), this.thisHost()), "heartbeat");
  }

  /** This process's host, which is what an absent owner host means. */
  private thisHost(): string {
    return this.identity.host ?? hostname();
  }

  /**
   * What can be PROVEN about a reservation's owner.
   *
   * - ALIVE: it is us, or the registry carries a fresh heartbeat for exactly
   *   this (pid, generation).
   * - DEAD: the registry shows a DIFFERENT, freshly heartbeating generation on
   *   that PID (a PID hosts one process at a time, so this one exited), or the
   *   PID is not running at all.
   * - UNKNOWN otherwise — a foreign process we cannot vouch for either way.
   *   It KEEPS its headroom: treating "I cannot tell" as death let a second
   *   manager reconcile a live owner's reservation and then hand out the
   *   headroom that owner was still spending (round 10 #7).
   */
  /** (host, pid) — the only identity a registry row can be looked up by. */
  private static ownerKey(host: string, pid: number): string {
    return `${host}\u0000${pid}`;
  }

  private ownerVerdict(
    owner: BudgetProcessIdentity,
    registry?: OwnerRegistry,
    /** The claim's place in the durable order, and its wall clock as a fallback. */
    claim?: { seq?: number; at?: number },
  ): OwnerVerdict {
    if (owner.pid === this.identity.pid && owner.generation === this.identity.generation) return "alive";
    // WHOSE PID IS THIS? (Codex round 12 #2.) A registry row from another
    // machine says nothing about this owner, and our own pid table cannot be
    // asked about a foreign pid at all: answering from it would call a live
    // remote owner dead and hand its headroom away.
    const here = this.thisHost();
    const ownerHost = owner.host ?? here;
    // Keyed by (host, pid): a registry keyed by pid alone let two machines
    // sharing one wallet overwrite each other's evidence (round 13 #2).
    const all = registry ?? this.ownerRegistry();
    const known = all.get(UnifiedBudgetManager.ownerKey(ownerHost, owner.pid))
      // A row written before hosts were recorded belongs to "here", because
      // that is what every single-machine install meant.
      ?? (ownerHost === here ? all.get(UnifiedBudgetManager.ownerKey("", owner.pid)) : undefined);
    if (known && known.generation !== owner.generation) {
      // SUPERSESSION DOES NOT EXPIRE (Codex round 11 #5). A pid hosts one
      // process at a time, so a DIFFERENT incarnation registering on it after
      // this liability was claimed proves the claimant exited — whether or not
      // the replacement is still heartbeating. Treating a stale replacement as
      // "unknown" let a dead owner's liability hold headroom for ever.
      // ORDER, NOT A CLOCK (round 13 #1). A reboot or an NTP step moves wall
      // clocks backwards, and a PREDECESSOR's `registered_at` then looked later
      // than a live successor's claim and "proved" it dead. The durable
      // sequence cannot move backwards, so it decides whenever both sides have
      // one; the timestamps are the fallback for rows written before it, and an
      // unknown order proves nothing at all.
      if (known.registeredSeq !== undefined && claim?.seq !== undefined) {
        if (known.registeredSeq >= claim.seq) return "dead";
      } else if (known.registeredAt !== undefined && (claim?.at === undefined || known.registeredAt >= claim.at)) {
        return "dead";
      }
    }
    if (known && known.generation === owner.generation && Date.now() - known.heartbeatAt <= OWNER_HEARTBEAT_TTL_MS) {
      return "alive";
    }
    // A DIFFERENT generation heartbeating right now is NOT proof on its own
    // (Codex round 12 #1): the row may be this owner's PREDECESSOR on the pid,
    // still inside the TTL, while the owner's own registration merely failed —
    // heartbeats are best effort. Only arrival order proves supersession, and
    // that is the check above. Unproven means UNKNOWN, which keeps the headroom.
    if (ownerHost !== here) return "unknown";
    return pidIsRunning(owner.pid) ? "unknown" : "dead";
  }

  private ownerRegistry(): OwnerRegistry {
    const rows = this.storage.listBudgetOwners?.() ?? [];
    return new Map(
      rows.map((row) => [
        UnifiedBudgetManager.ownerKey(row.ownerHost ?? "", row.ownerPid),
        {
          generation: row.ownerGeneration,
          heartbeatAt: row.heartbeatAt,
          ...(row.registeredAt === undefined ? {} : { registeredAt: row.registeredAt }),
          ...(row.registeredSeq === undefined ? {} : { registeredSeq: row.registeredSeq }),
          ...(row.ownerHost === undefined || row.ownerHost === null ? {} : { host: row.ownerHost }),
        },
      ]),
    );
  }

  /** May this process resolve someone else's liability as uncertain estimate? */
  private isReclaimable(
    row: {
      ownerPid: number;
      ownerGeneration?: string | null;
      ownerHost?: string | null;
      createdAt?: number;
      claimSeq?: number | null;
      lastActivityAt?: number | null;
    },
    registry?: OwnerRegistry,
  ): boolean {
    // Written before owner generations existed: it names no incarnation that
    // could still be running, so nothing can keep it in flight.
    if (!row.ownerGeneration) return true;
    const owner = { pid: row.ownerPid, generation: row.ownerGeneration, ...(row.ownerHost ? { host: row.ownerHost } : {}) };
    if (this.injectedIsOwnerAlive) return !this.injectedIsOwnerAlive(owner);
    // WHERE THIS OWNER'S CLAIM SITS IN THE ORDER: a registration before it
    // names a PREDECESSOR on the pid, not a replacement, so it proves nothing
    // (the ABA direction of round 11 #5).
    //
    // Deliberately NOT lastActivityAt (Codex round 12 #3): a charge can be
    // recorded against this reservation by whichever process is doing the
    // accounting, so activity does not authenticate the OWNER as alive — and
    // letting it move the claim forward erased a replacement's proof.
    const claim = {
      ...(row.claimSeq === undefined || row.claimSeq === null ? {} : { seq: row.claimSeq }),
      ...(row.createdAt === undefined || row.createdAt <= 0 ? {} : { at: row.createdAt }),
    };
    return this.ownerVerdict(owner, registry, claim) === "dead";
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
    // Register as a live owner BEFORE the row exists, so no reservation is ever
    // durable while its owner is unregistered (round 10 #7).
    this.heartbeat();
    this.storage.upsertBudgetReservation({
      id, source, sourceId: sourceId ?? null, estimateUsd: amount, chargedUsd: 0,
      ownerPid: this.identity.pid, ownerGeneration: this.identity.generation, ownerHost: this.thisHost(), createdAt, lastActivityAt: null,
    });
    this.reservations.set(id, reservation);
    return id;
  }

  /** Best-effort durable writes: on failure the safe state (liability retained) stands. */
  private persist(write: () => void, what: string): void {
    try {
      write();
    } catch (error) {
      getLoggerSafe().warn("A best-effort budget write did not land; durable liability remains", {
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
    this.heartbeat(); // booking cost is proof this process is working
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
    // Claim this PID for this incarnation first: that registration is what
    // proves a previous incarnation of the same PID is gone.
    this.heartbeat();
    this.persist(() => this.storage.pruneBudgetOwners?.(Date.now() - OWNER_REGISTRY_RETENTION_MS), "prune owners");
    const registry = this.ownerRegistry();
    let orphans = 0;
    let estimatedUsd = 0;
    for (const candidate of rows) {
      if (candidate.reconciledAt != null) continue;
      // ONLY PROVEN DEATH RELEASES SOMEONE ELSE'S LIABILITY (round 10 #7).
      if (!this.isReclaimable(candidate, registry)) continue;
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
    // Outside the transaction: a rolled-back cost must not erase the evidence
    // that this process is alive, and a failed heartbeat must not fail the cost.
    this.heartbeat();
    this.transaction(() => {
      const entry = {
        costUsd: amount, model: metadata.model, tokensIn: metadata.tokensIn,
        tokensOut: metadata.tokensOut, triggerName: metadata.triggerName,
        timestamp: now, source, agentId: source === "agent" ? metadata.agentId : undefined,
        // WHAT THIS PIECE OF WORK COST (plan 6.1): the task and campaign the
        // caller named travel with the row, so a task's own spend is a query
        // instead of a window total nobody can attribute.
        taskId: metadata.taskId, campaignId: metadata.campaignId,
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
    // EACH WINDOW COUNTS ITS OWN LIABILITY (round 10 #6). These gates used to
    // ask for outstanding liability with no window while canSpend() scoped it
    // to the window being tested, so a reconciled liability from 25 hours ago
    // let a run be ADMITTED and then refused permission to execute — a wallet
    // that could never be unblocked. Admission and execution must ask the same
    // question of the same window.
    if (hasBudgetLimit(config.dailyLimitUsd)) {
      const dailyStart = now - ROLLING_WINDOW_MS;
      const dailyUsed = this.storage.sumBudgetSince(dailyStart);
      const outstanding = this.outstandingUsd({ ignoreReservationId: opts?.ignoreReservationId, since: dailyStart });
      if (dailyUsed + outstanding >= config.dailyLimitUsd) return true;
    }
    if (hasBudgetLimit(config.monthlyLimitUsd)) {
      const monthlyStart = now - MONTHLY_WINDOW_MS;
      const monthlyUsed = this.storage.sumBudgetSince(monthlyStart);
      const outstanding = this.outstandingUsd({ ignoreReservationId: opts?.ignoreReservationId, since: monthlyStart });
      if (monthlyUsed + outstanding >= config.monthlyLimitUsd) return true;
    }
    return false;
  }

  isSourceExceeded(source: BudgetSource, sourceId?: string, opts?: BudgetGateOptions): boolean {
    const config = this.configStore.getConfig();
    const dailyStart = Date.now() - ROLLING_WINDOW_MS;
    const ignoreReservationId = opts?.ignoreReservationId;
    // Sub-limits are DAILY, so their liability is scoped to the daily window —
    // the same scope canSpend() uses for them (round 10 #6).
    if (source === "daemon") {
      if (config.subLimits.daemonDailyUsd <= 0) return false;
      const outstanding = this.outstandingUsd({ source: "daemon", ignoreReservationId, since: dailyStart });
      return this.storage.sumBudgetForSource("daemon", dailyStart) + outstanding >= config.subLimits.daemonDailyUsd;
    }
    if (source === "agent" && sourceId) {
      if (config.subLimits.agentDefaultUsd <= 0) return false;
      const outstanding = this.outstandingUsd({ source: "agent", sourceId, ignoreReservationId, since: dailyStart });
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
