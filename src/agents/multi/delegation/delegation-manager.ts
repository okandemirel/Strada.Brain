/**
 * Delegation Manager
 *
 * Orchestrates sub-agent lifecycle for task delegation:
 * - Spawns Orchestrator instances with tier-resolved providers
 * - Enforces concurrency limits and depth-based tool filtering
 * - Implements escalation chain (cheap -> standard -> premium)
 * - Tracks delegation lifecycle via DelegationLog and TypedEventBus
 * - Deducts costs from parent agent budget
 * - Supports sync and async delegation modes
 * - Timeout via AbortController cancels long-running sub-agents
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

import { randomUUID } from "node:crypto";
import { getLoggerSafe } from "../../../utils/logger.js";
import { estimateCostWithCache } from "../../../budget/cost-model.js";
import type { IChannelAdapter, IncomingMessage } from "../../../channels/channel.interface.js";
import type { IEventBus, LearningEventMap } from "../../../core/event-bus.js";
import type { ITool } from "../../tools/tool.interface.js";
import type { AgentBudgetTracker } from "../agent-budget-tracker.js";
import type { AgentId } from "../agent-types.js";
import type { StradaDepsStatus } from "../../../config/strada-deps.js";
import type { StradaDependencyConfig } from "../../../config/config.js";
import type {
  DelegationConfig,
  DelegationRequest,
  DelegationResult,
  DelegationTypeConfig,
  ModelTier,
} from "./delegation-types.js";
import type { DelegationLog } from "./delegation-log.js";
import type { TierRouter } from "./tier-router.js";
import type { ProviderCredentialMap, ProviderConfig } from "../../providers/provider-registry.js";
import { createProvider, PROVIDER_PRESETS } from "../../providers/provider-registry.js";
import { ProviderManager } from "../../providers/provider-manager.js";
import { Orchestrator } from "../../orchestrator.js";
import { getProviderIntelligenceSnapshot, type ProviderWorkload, type ModelIntelligenceLookup } from "../../providers/provider-knowledge.js";
import { ProviderHealthRegistry } from "../../providers/provider-health.js";
import { isCurrentChainMemberName } from "../../providers/provider-outage.js";
import { WorkspaceLeaseManager, type WorkspaceCommitResult } from "../workspace-lease-manager.js";
import {
  selectAgentRunner,
  toWorkerRunResult,
  type RunnerHostOrchestrator,
} from "../../../agent-core/runner/index.js";

// =============================================================================
// OPTIONS
// =============================================================================

export interface DelegationManagerOptions {
  /** One authorization store shared with the root Orchestrator — see AgentManagerOptions. */
  readonly authorizedPathsStore?: Map<string, readonly string[]>;
  /** Live framework knowledge for the delegated orchestrator — see the call
   *  site; without it the sub-agent runs on the static prompt. */
  readonly frameworkPromptGenerator?: () => import("../../../intelligence/framework/framework-prompt-generator.js").FrameworkPromptGenerator | undefined;
  readonly config: DelegationConfig;
  readonly tierRouter: TierRouter;
  readonly delegationLog: DelegationLog;
  readonly eventBus: IEventBus<LearningEventMap>;
  readonly budgetTracker: AgentBudgetTracker;
  readonly channel: IChannelAdapter;
  readonly projectPath: string;
  readonly readOnly: boolean;
  readonly defaultLanguage?: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";
  readonly streamInitialTimeoutMs?: number;
  readonly streamStallTimeoutMs?: number;
  readonly stradaDeps: StradaDepsStatus;
  readonly stradaConfig?: Partial<StradaDependencyConfig>;
  readonly parentTools: ITool[];
  readonly apiKeys: Record<string, string | undefined>;
  readonly providerCredentials?: ProviderCredentialMap;
  /** Per-provider base-URL overrides (e.g. OpenCode's OPENCODE_BASE_URL = Zen vs Go).
   *  MUST be threaded into every sub-agent/candidate provider, or opencode silently
   *  falls back to its Zen preset default and hits the wrong (uncredited) endpoint. */
  readonly providerBaseUrls?: Record<string, string>;
  /**
   * Per-provider model overrides (config.providerModels). Without them a
   * delegated sub-agent fell back to PROVIDER_PRESETS' default — measured
   * 2026-08-31: every opencode alias ran the PAID qwen3.6-plus while the
   * deployment was pinned to a free tier, producing CreditsErrors.
   */
  readonly providerModels?: Record<string, string>;
  /** Per-attempt first-response timeout (ms) for sub-agent provider chains — without
   *  it the sub-agent ProviderManager runs with attemptTimeoutMs=0 (unbounded), so a
   *  dead tier provider never fails over fast. Threaded from llmProviderFirstResponseTimeoutMs. */
  readonly providerResponseTimeoutMs?: number;
  readonly preferencesDbPath?: string;
  readonly verifiedLocalProviders?: readonly string[];
  readonly workspaceLeaseManager?: WorkspaceLeaseManager;
  readonly providerRouter?: ConstructorParameters<typeof Orchestrator>[0]["providerRouter"];
  readonly vaultRegistry?: import("../../../vault/vault-registry.js").VaultRegistry;
  readonly vaultWriteHookBudgetMs?: number;
  /**
   * Live model-intelligence catalog (LiteLLM/models.dev refreshed). When present,
   * delegation candidate scoring uses fresh per-model capability/cost data instead
   * of degrading to behavioral-profile + static-capability defaults.
   */
  readonly modelIntelligence?: ModelIntelligenceLookup;
  /**
   * Resolve the live per-agent budget cap (USD) for a parent agent. When present,
   * delegations are rejected before spawn if the parent has already exceeded its
   * cap (mirrors AgentManager.isAgentExceeded enforcement). Looked up fresh at
   * delegation time so runtime cap changes are honored. Returns undefined when the
   * agent is unknown, in which case the budget gate is skipped (no-op).
   */
  readonly getAgentBudgetCap?: (agentId: AgentId) => number | undefined;
}

// =============================================================================
// ACTIVE DELEGATION TRACKING
// =============================================================================

interface ActiveDelegation {
  readonly abortController: AbortController;
  readonly logId: number;
  readonly parentAgentId: string;
  readonly type: string;
  readonly startedAt: number;
  /**
   * Set by cancelDelegation BEFORE the abort fires. The catch in
   * executeSingleDelegation only sees `signal.aborted`, which is equally true
   * for a timeout, so without this flag a cancellation was accounted, logged
   * and emitted as "Delegation timed out" (audited 2026-09-02).
   */
  cancelled: boolean;
  /**
   * Resolves once executeSingleDelegation's finally has finished — i.e. after
   * the lease commit and release. shutdown() awaits these; before it did, it
   * aborted and returned while the commits were still running and bootstrap
   * reached process.exit(0) first (audited 2026-09-02).
   */
  readonly settled: Promise<void>;
}

/** How long shutdown() waits for aborted delegations to commit their leases. */
const DELEGATION_SHUTDOWN_SETTLE_MS = 10_000;

interface ResolvedDelegationProviderConfig {
  readonly name: string;
  readonly model: string;
}

// =============================================================================
// CAPTURE CHANNEL
// =============================================================================

/**
 * Minimal IChannelAdapter that captures sub-agent output instead of sending
 * it to a real channel. The Orchestrator calls channel.sendText/sendMarkdown
 * with the final response, and CaptureChannel records it.
 */
class CaptureChannel implements IChannelAdapter {
  readonly name = "capture";
  private captured = "";

  async connect(): Promise<void> {
    /* no-op */
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }
  isHealthy(): boolean {
    return true;
  }
  onMessage(): void {
    /* no-op */
  }
  async sendText(_chatId: string, text: string): Promise<void> {
    this.captured += (this.captured ? "\n" : "") + text;
  }
  async sendMarkdown(_chatId: string, markdown: string): Promise<void> {
    this.captured += (this.captured ? "\n" : "") + markdown;
  }

  getLastResponse(): string {
    return this.captured;
  }
}

// =============================================================================
// DELEGATION MANAGER
// =============================================================================

export class DelegationManager {
  private readonly opts: DelegationManagerOptions;

  /** Active delegations keyed by subAgentId */
  private readonly activeDelegations = new Map<string, ActiveDelegation>();

  /** Active delegation count per parent agent */
  private readonly parentConcurrency = new Map<string, number>();

  /**
   * Live model-intelligence catalog used by candidate scoring. Seeded from opts
   * but settable post-construction because the ModelIntelligenceService is created
   * later in bootstrap than the DelegationManager.
   */
  private modelIntelligence?: ModelIntelligenceLookup;

  constructor(opts: DelegationManagerOptions) {
    this.opts = opts;
    this.modelIntelligence = opts.modelIntelligence;
  }

  /** Wire (or refresh) the live model-intelligence catalog used for scoring. */
  setModelIntelligence(modelIntelligence: ModelIntelligenceLookup | undefined): void {
    this.modelIntelligence = modelIntelligence;
  }

  /**
   * The tier router backing this manager. Exposed so the composition root can
   * push freshly-derived tier specs in when the model catalog refreshes.
   */
  getTierRouter(): TierRouter {
    return this.opts.tierRouter;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Synchronous delegation: spawn a sub-agent, wait for result, return it.
   */
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const { typeConfig, effectiveTier, reservationId } = this.prepareRequest(request);
    // The concurrency slot reserved by prepareRequest is released inside
    // executeWithEscalation's per-attempt finally, so no compensation is needed
    // here (and adding any would double-release). The budget reservation is
    // released by executeWithEscalation's outer finally for the same reason.
    return await this.executeWithEscalation(request, typeConfig, effectiveTier, reservationId);
  }

  /**
   * Asynchronous delegation: fire-and-forget, emits events when done.
   */
  async delegateAsync(request: DelegationRequest): Promise<void> {
    const { typeConfig, effectiveTier, reservationId } = this.prepareRequest(request);

    // Events are already emitted inside executeSingleDelegation with correct subAgentId.
    // Only swallow rejection to prevent unhandled promise rejection.
    this.executeWithEscalation(request, typeConfig, effectiveTier, reservationId).catch(() => {
      // Already logged and emitted inside executeSingleDelegation
    });
  }

  /**
   * Cancel a running delegation by subAgentId.
   */
  cancelDelegation(subAgentId: string): void {
    const delegation = this.activeDelegations.get(subAgentId);
    if (!delegation) return;

    delegation.cancelled = true;
    delegation.abortController.abort();
    this.opts.delegationLog.cancel(delegation.logId);
    // Remove the active entry now; the slot is released when the aborted
    // executeSingleDelegation unwinds through executeWithEscalation's finally,
    // so cancelDelegation must NOT decrement (that would double-release).
    this.cleanup(subAgentId);
  }

  /**
   * Get active delegations, optionally filtered by parent.
   */
  getActiveDelegations(
    parentAgentId?: string,
  ): Array<{ subAgentId: string; type: string; startedAt: number }> {
    const results: Array<{ subAgentId: string; type: string; startedAt: number }> = [];

    for (const [subAgentId, delegation] of this.activeDelegations) {
      if (!parentAgentId || delegation.parentAgentId === parentAgentId) {
        results.push({
          subAgentId,
          type: delegation.type,
          startedAt: delegation.startedAt,
        });
      }
    }

    return results;
  }

  /**
   * Shutdown: cancel all active delegations, WAIT for their lease commits,
   * then dispose the delegation lease manager.
   *
   * shutdown() used to abort each delegation and return in the same tick.
   * The commit that publishes a sub-agent's files lives in the aborted run's
   * finally, so bootstrap walked on to process.exit(0) while those commits
   * were still waiting on the project write lock; the writes missed the
   * project and resurfaced only as an orphan quarantine on the next boot.
   * The lease manager built for delegation was also never disposed — the
   * only dispose() in the tree belonged to the background executor's own
   * instance (audited 2026-09-02).
   *
   * The wait is bounded; a delegation still committing at the deadline is
   * counted and named, never silently abandoned.
   */
  async shutdown(settleTimeoutMs: number = DELEGATION_SHUTDOWN_SETTLE_MS): Promise<void> {
    await this.shutdownAndReport(settleTimeoutMs);
  }

  /** shutdown() with its measurement: how many were cancelled and how many
   *  were still committing when the deadline hit (0 when all settled). */
  async shutdownAndReport(
    settleTimeoutMs: number = DELEGATION_SHUTDOWN_SETTLE_MS,
  ): Promise<{ cancelled: number; stillCommitting: number }> {
    const inFlight = [...this.activeDelegations.values()].map((d) => d.settled);
    for (const [subAgentId] of this.activeDelegations) {
      this.cancelDelegation(subAgentId);
    }

    let stillCommitting = 0;
    if (inFlight.length > 0) {
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        deadlineTimer = setTimeout(() => resolve("deadline"), settleTimeoutMs);
        deadlineTimer.unref?.();
      });
      let settledCount = 0;
      const tracked = inFlight.map((p) => p.then(() => { settledCount++; }));
      const outcome = await Promise.race([
        Promise.allSettled(tracked).then(() => "settled" as const),
        deadline,
      ]);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (outcome === "deadline") {
        stillCommitting = inFlight.length - settledCount;
        getLoggerSafe().warn(
          "Delegation shutdown deadline reached with lease commits still running — their workspaces stay on disk for orphan salvage on the next start",
          { settleTimeoutMs, cancelled: inFlight.length, stillCommitting },
        );
      }
    }

    await this.opts.workspaceLeaseManager?.dispose();
    return { cancelled: inFlight.length, stillCommitting };
  }

  // ===========================================================================
  // PRIVATE: REQUEST PREPARATION
  // ===========================================================================

  /**
   * Shared setup for delegate() and delegateAsync(): resolve type config,
   * check concurrency, and determine effective tier.
   */
  private prepareRequest(request: DelegationRequest): {
    typeConfig: DelegationTypeConfig;
    effectiveTier: ModelTier;
    reservationId?: string;
  } {
    const typeConfig = this.resolveTypeConfig(request.type);
    const effectiveTier = this.opts.tierRouter.getTypeEffectiveTier(
      request.type,
      typeConfig.tier,
    );

    // Health gate: prevent thundering herd against overloaded providers
    const healthRegistry = ProviderHealthRegistry.getInstance();
    // Measure only live chain members: a stale entry for a de-configured
    // provider or a healthy "chain(...)" alias defeated the every(down)
    // reduction — the exact hazard provider-outage.ts documents.
    const members = [...healthRegistry.getAllEntries()]
      .filter(([name]) => isCurrentChainMemberName(name));
    if (members.length > 0) {
      const now = Date.now();
      const allDown = members.every(
        ([, e]) => e.status === "down" && now < e.cooldownUntil,
      );
      if (allDown) {
        // Only hard-abort when recovery is NOT imminent. When the soonest provider is about
        // to exit a transient cooldown, let delegation proceed — the sub-agent's FallbackChain
        // performs a single bounded wait-for-recovery (the one place the wait lives) instead of
        // failing the whole task on a brief all-cooled blip. The FallbackChain probing guard
        // still prevents a thundering herd of concurrent probes to the recovering provider.
        //
        // Scoped to the SAME members as the reduction above. Unscoped, the probe
        // read every tracked entry, so a de-configured provider (or a "chain(...)"
        // alias) cooling for 30s made recovery look imminent while the only real
        // member was quota-dead for hours — the gate then spawned every delegation
        // into the wall (audited 2026-09-02).
        const recoveryImminent =
          healthRegistry.suggestRecoveryWaitMs(now, members.map(([name]) => name)) !== null;
        if (!recoveryImminent) {
          throw new Error("All providers are in cooldown — delegation skipped to prevent thundering herd");
        }
      }
    }

    // Budget gate: reject before spawning if the parent has already exceeded its
    // per-agent cap. Mirrors AgentManager.isAgentExceeded(id, cap). Optional — when
    // no cap is resolvable (no resolver wired or agent unknown) this is a no-op so
    // delegation continues unchanged. Runs before acquiring a concurrency slot so a
    // rejected delegation never reserves a slot.
    const parentAgentId = request.parentAgentId as AgentId;
    const budgetCapUsd = this.opts.getAgentBudgetCap?.(parentAgentId);
    let reservationId: string | undefined;
    if (budgetCapUsd !== undefined) {
      if (this.opts.budgetTracker.isAgentExceeded(parentAgentId, budgetCapUsd)) {
        const usage = this.opts.budgetTracker.getAgentUsage(parentAgentId, budgetCapUsd);
        throw new Error(
          `Parent agent budget exceeded ($${usage.usedUsd.toFixed(2)} / $${budgetCapUsd.toFixed(2)}) — delegation rejected before spawn.`,
        );
      }

      // The recorded-spend check above is check-then-act: nothing is charged until a
      // sub-agent settles, so N concurrent delegations (one swarm_tasks fan-out) all
      // read the SAME pre-spawn total and all passed it — a parent at 95% of its cap
      // could breach it N times over. Each delegation now RESERVES a pessimistic
      // estimate that its siblings can see, so the overshoot is bounded by one
      // delegation instead of the fan-out width (audited 2026-09-02).
      //
      // The refusal is on what is ALREADY committed (spent + reserved), not on this
      // delegation's own estimate, so a single delegation under the cap is admitted
      // exactly as before — the gate never became stricter than it was.
      const commitment = this.opts.budgetTracker.getAgentCommitment(parentAgentId, budgetCapUsd);
      if (commitment.reservedUsd > 0 && commitment.committedUsd >= budgetCapUsd) {
        throw new Error(
          `Parent agent budget committed ($${commitment.usedUsd.toFixed(2)} spent + ` +
            `$${commitment.reservedUsd.toFixed(2)} reserved by delegations already in flight ` +
            `/ $${budgetCapUsd.toFixed(2)} cap) — delegation rejected before spawn.`,
        );
      }
      // Pessimistic: the tier's cost model over the type's FULL timeout, i.e. the
      // most this run can cost by the only model available before it starts. It is
      // an estimate and is labelled as one — it is replaced by the measured cost
      // when the delegation settles, never left standing as spend.
      reservationId = this.opts.budgetTracker.reserve(
        parentAgentId,
        this.estimateDelegationCost(effectiveTier, typeConfig.timeoutMs),
      );
    }

    try {
      // Atomically check + reserve concurrency slot to prevent TOCTOU race
      this.acquireConcurrencySlot(request.parentAgentId);
    } catch (error) {
      // A delegation refused a slot never runs, so its reservation must not
      // outlive it and shrink the parent's cap.
      if (reservationId) this.opts.budgetTracker.release(reservationId);
      throw error;
    }

    return { typeConfig, effectiveTier, reservationId };
  }

  // ===========================================================================
  // PRIVATE: ESCALATION
  // ===========================================================================

  private async executeWithEscalation(
    request: DelegationRequest,
    typeConfig: DelegationTypeConfig,
    tier: ModelTier,
    reservationId?: string,
  ): Promise<DelegationResult> {
    try {
      return await this.runEscalation(request, typeConfig, tier, reservationId);
    } finally {
      // Whatever the outcome, the work is no longer in flight, so its headroom
      // must go back: a reservation that outlives its delegation is a silent cap.
      // settleCost already replaced it with the measured cost on every path that
      // reached a settlement; this covers the ones that threw before it.
      if (reservationId) this.opts.budgetTracker.release(reservationId);
    }
  }

  private async runEscalation(
    request: DelegationRequest,
    typeConfig: DelegationTypeConfig,
    tier: ModelTier,
    reservationId?: string,
  ): Promise<DelegationResult> {
    // Attempt 1 — slot reserved by prepareRequest. The inner finally releases it
    // exactly once whether the attempt returns, throws during execution, or
    // throws during setup before executeSingleDelegation's own try is reached —
    // so no caller (delegate/delegateAsync) and no sibling-sensitive guard is
    // needed to compensate.
    try {
      try {
        return await this.executeSingleDelegation(request, typeConfig, tier, undefined, reservationId);
      } finally {
        this.decrementConcurrency(request.parentAgentId);
      }
    } catch (error) {
      // Do not escalate aborted/cancelled/timed-out delegations, nor one whose
      // sub-agent finished but whose workspace commit failed — that is the
      // project root, not the model, and a pricier tier would redo the work
      // only to lose it the same way (audited 2026-09-02).
      if (
        error instanceof Error &&
        (error.message.includes("aborted") ||
          error.message.includes("timed out") ||
          error.message.startsWith("Delegated workspace commit failed"))
      ) {
        throw error;
      }

      const nextTier = this.opts.tierRouter.getEscalationTier(tier);
      if (!nextTier) {
        throw error;
      }

      // Escalate: retry with the next tier on a freshly reserved slot, released
      // by its own finally regardless of outcome.
      this.acquireConcurrencySlot(request.parentAgentId);
      try {
        return await this.executeSingleDelegation(request, typeConfig, nextTier, tier, reservationId);
      } finally {
        this.decrementConcurrency(request.parentAgentId);
      }
    }
  }

  // ===========================================================================
  // PRIVATE: SINGLE DELEGATION EXECUTION
  // ===========================================================================

  private async executeSingleDelegation(
    request: DelegationRequest,
    typeConfig: DelegationTypeConfig,
    tier: ModelTier,
    escalatedFrom?: ModelTier,
    /** Budget headroom held for this delegation by prepareRequest, if any. */
    reservationId?: string,
  ): Promise<DelegationResult> {
    const { delegationLog, eventBus, budgetTracker } = this.opts;
    const subAgentId = randomUUID();
    const startTime = Date.now();

    // Resolve provider for this tier
    const providerConfig = this.resolveDelegationProviderConfig(tier, typeConfig);
    const provider = createProvider(this.buildDelegationProviderConfig(providerConfig.name, providerConfig.model));

    const providerManager = new ProviderManager(
      provider,
      this.opts.providerCredentials ?? {},
      this.opts.providerModels, // modelOverrides — sub-agent chains keep the deployment's pinned models
      this.opts.preferencesDbPath,
      [], // defaultProviderOrder
      this.opts.providerBaseUrls?.["ollama"], // ollamaBaseUrl (threaded via the providerBaseUrls merge in stage-agents)
      this.opts.providerBaseUrls, // baseUrlOverrides — keeps sub-agent chains on the configured (Go) endpoint
      this.opts.providerResponseTimeoutMs, // first-response timeout so dead tier providers fail over fast
    );
    const subAgentTools = this.buildSubAgentTools(request.depth);

    const systemPrompt =
      typeConfig.systemPrompt ??
      `You are a specialized sub-agent for ${typeConfig.name.replace(/_/g, " ")} tasks. Complete the assigned task concisely and return the result. Do not delegate further.`;

    // Set up timeout with abort controller
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), typeConfig.timeoutMs);

    // Log start
    const logId = delegationLog.start({
      parentAgentId: request.parentAgentId,
      subAgentId,
      type: request.type,
      model: providerConfig.model,
      tier,
      depth: request.depth,
    });

    // Track active delegation (concurrency already reserved in prepareRequest)
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const active: ActiveDelegation = {
      abortController,
      logId,
      parentAgentId: request.parentAgentId,
      type: request.type,
      startedAt: startTime,
      cancelled: false,
      settled,
    };
    this.activeDelegations.set(subAgentId, active);

    eventBus.emit("delegation:started", {
      parentAgentId: request.parentAgentId,
      subAgentId,
      type: request.type,
      tier,
      model: providerConfig.model,
      depth: request.depth,
      mode: request.mode,
      timestamp: startTime,
    });

    const captureChannel = new CaptureChannel();
    let workspaceLease: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>> | undefined;

    // Real usage accounting. The delegated Orchestrator/runner used to get NO
    // usage sink, so the only thing ever charged for a sub-agent was
    // tier x seconds with tokensIn/tokensOut = 0 — a premium run burning 800k
    // tokens in 25s billed $0.05, and on a flat-fee chain the same guess
    // charged imaginary money. Every provider turn is billed here exactly the
    // way AgentManager bills the parent; the tier estimate survives only as a
    // labelled fallback for a run that reported no usage (audited 2026-09-02).
    const parentAgentId = request.parentAgentId as AgentId;
    let usageEvents = 0;
    let measuredCostUsd = 0;
    const onUsage = (usage: {
      provider: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    }): void => {
      usageEvents++;
      const costUsd = estimateCostWithCache(usage, usage.provider);
      measuredCostUsd += costUsd;
      if (costUsd <= 0) return; // flat-fee / local provider: nothing to charge
      budgetTracker.recordCost(parentAgentId, costUsd, {
        model: usage.model ?? usage.provider,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        // Real spend as it lands shrinks the reservation it was reserved
        // against, so a running delegation is never counted twice.
        reservationId,
      });
    };
    /** The cost to report: measured when any usage arrived, else the tier
     *  estimate — recorded and logged as an estimate, never silently. */
    const settleCost = (durationMs: number, outcome: "completed" | "timeout" | "cancelled"): number => {
      if (usageEvents > 0) {
        // Replace the up-front estimate with what this run actually cost. Every
        // usage event was already recorded against the reservation, so settle
        // finds nothing unbilled and charges nothing twice.
        if (reservationId) budgetTracker.settle(reservationId, parentAgentId, measuredCostUsd);
        return measuredCostUsd;
      }
      const estimatedCostUsd = this.estimateDelegationCost(tier, durationMs);
      const recordEstimate = { model: providerConfig.model, tokensIn: 0, tokensOut: 0 };
      if (reservationId) {
        budgetTracker.settle(reservationId, parentAgentId, estimatedCostUsd, recordEstimate);
      } else {
        budgetTracker.recordCost(parentAgentId, estimatedCostUsd, recordEstimate);
      }
      getLoggerSafe().warn("Delegated sub-agent reported no token usage — billing the tier estimate", {
        subAgentId,
        tier,
        outcome,
        durationMs,
        estimatedCostUsd,
      });
      return estimatedCostUsd;
    };

    // The workspace commit used to live only in the `finally`, AFTER
    // delegationLog.complete, delegation:completed and the return literal had
    // all declared success; its result went to one info line. A sub-agent
    // whose file was quarantined as a conflict, skipped as unprocessable, or
    // whose deletion was declined reported "done" to the parent and the
    // project never received it. Commit ONCE, on the success path before
    // anything claims success, and let the finally cover the failure paths
    // (audited 2026-09-02).
    let commitAttempted = false;
    let commitOutcome: WorkspaceCommitResult | undefined;
    let commitError: unknown;
    const commitWorkspace = async (): Promise<void> => {
      if (commitAttempted || !workspaceLease) return;
      commitAttempted = true;
      try {
        commitOutcome = await workspaceLease.commit();
        if (
          commitOutcome.written.length > 0 ||
          commitOutcome.conflicts.length > 0 ||
          commitOutcome.failed.length > 0 ||
          commitOutcome.removed.length > 0
        ) {
          getLoggerSafe().info("Delegated workspace committed", {
            subAgentId,
            files: commitOutcome.written.length,
            conflicts: commitOutcome.conflicts.length,
            failed: commitOutcome.failed.length,
            removed: commitOutcome.removed.length,
            quarantinedUnder: commitOutcome.conflictsQuarantinedUnder,
          });
        }
      } catch (err) {
        commitError = err;
        getLoggerSafe().error("Delegated workspace commit failed — sub-agent work discarded", {
          subAgentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    try {
      workspaceLease = this.opts.workspaceLeaseManager
        ? await this.opts.workspaceLeaseManager.acquireLease({
          label: `delegation-${request.type}`,
          workerId: subAgentId,
        })
        : undefined;
      const orchestrator = new Orchestrator({
        providerManager,
        tools: subAgentTools,
        channel: captureChannel,
        projectPath: workspaceLease?.path ?? this.opts.projectPath,
        readOnly: this.opts.readOnly,
        requireConfirmation: false,
        defaultLanguage: this.opts.defaultLanguage,
        streamInitialTimeoutMs: this.opts.streamInitialTimeoutMs,
        streamStallTimeoutMs: this.opts.streamStallTimeoutMs,
        stradaDeps: this.opts.stradaDeps,
        stradaConfig: this.opts.stradaConfig,
        providerRouter: this.opts.providerRouter,
        vaultRegistry: this.opts.vaultRegistry,
        vaultWriteHookBudgetMs: this.opts.vaultWriteHookBudgetMs,
        maxIterations: typeConfig.maxIterations,
        authorizedPathsStore: this.opts.authorizedPathsStore,
        onUsage,
      });
      // Carry the user's authorization across the instance boundary, keyed to
      // the delegate's own chat id — a worker cannot authorize itself, so this
      // only ever hands down what the parent already holds.
      // The parent's tool context already carries what the user authorized.
      const inherited = request.toolContext?.userAuthorizedPaths ?? [];
      orchestrator.seedUserAuthorizedPaths(`delegation-${subAgentId}`, inherited);

      // A delegated agent that cannot see the installed framework writes code
      // that only looks like it belongs to it. Without this it runs on the
      // static STRADA_SYSTEM_PROMPT — no Core namespaces, no base classes, no
      // MCP tool list, no generator guidance.
      // A getter, not the instance: bootstrap builds the generator in a
      // deferred async step that may finish after this manager is constructed.
      const frameworkGenerator = this.opts.frameworkPromptGenerator?.();
      if (frameworkGenerator) {
        orchestrator.setFrameworkPromptGenerator(frameworkGenerator);
      }

      const message: IncomingMessage = {
        channelType: "cli",
        chatId: `delegation-${subAgentId}`,
        userId: "sub-agent",
        text: request.context
          ? `${systemPrompt}\n\nTask: ${request.task}\n\nContext: ${request.context}`
          : `${systemPrompt}\n\nTask: ${request.task}`,
        timestamp: new Date(),
      };

      let workerResult: import("../../supervisor/supervisor-types.js").WorkerRunResult | undefined;
      if (typeof (orchestrator as Orchestrator & { createAgentCorePort?: unknown }).createAgentCorePort === "function") {
        // Route the delegated sub-agent through the AgentRunner seam (the V2 spine — cutover
        // Step 5 deleted the v1 engine; the probe now keys on the Agent Core wiring hook, NOT the
        // deleted runWorkerTask). Mirrors background-executor.executeWorkerRun: supervisor-node ⇒
        // the "delegated" worker mode; the never-returning waitForAbort still races the run for
        // the delegation timeout; toWorkerRunResult projects AgentRunResult → WorkerRunResult.
        const mode = "supervisor-node" as const;
        const runner = selectAgentRunner(orchestrator as unknown as RunnerHostOrchestrator, mode);
        const runResult = await Promise.race([
          runner.run(
            {
              prompt: message.text,
              chatId: message.chatId,
              taskRunId: subAgentId,
              channelType: message.channelType,
              userId: message.userId,
              workspaceLease,
              // The V2 runner reads its sink from the REQUEST, not the Orchestrator.
              onUsage,
            },
            {
              mode,
              onEvent: () => {},
              externalSignal: abortController.signal,
              deliverFinal: () => {},
            },
          ),
          this.waitForAbort(
            abortController.signal,
            `delegation(${request.type}, sub=${subAgentId}, timeoutMs=${typeConfig.timeoutMs})`,
          ),
        ]);
        workerResult = toWorkerRunResult(runResult);
      } else {
        // Execute with abort awareness
        await Promise.race([
          orchestrator.handleMessage(message),
          this.waitForAbort(
            abortController.signal,
            `delegation(${request.type}, sub=${subAgentId}, timeoutMs=${typeConfig.timeoutMs})`,
          ),
        ]);
      }

      // Timed out (signal aborted). Just surface it — ALL timeout accounting/logging
      // happens in the catch's aborted branch below, which is the path actually taken
      // when waitForAbort rejects the race (the common case). Handling it in one place
      // avoids both the dropped-accounting bug and any double-count on a same-tick race.
      if (abortController.signal.aborted) {
        throw new Error(`Delegation ${request.type} timed out after ${typeConfig.timeoutMs}ms`);
      }

      if (workerResult?.status === "failed") {
        throw new Error(
          workerResult.reason ?? (workerResult.finalSummary || "Delegated worker did not complete"),
        );
      }

      // Publish the sub-agent's files BEFORE anything records success: a commit
      // that throws means the work was discarded, which is a failed delegation,
      // not a completed one.
      await commitWorkspace();
      if (commitError !== undefined) {
        throw new Error(
          "Delegated workspace commit failed — sub-agent work discarded: " +
            (commitError instanceof Error ? commitError.message : String(commitError)),
        );
      }
      const commitSummary = commitOutcome
        ? {
            written: commitOutcome.written.length,
            conflicts: [...commitOutcome.conflicts],
            failed: [...commitOutcome.failed],
            removed: [...commitOutcome.removed],
            quarantinedUnder: commitOutcome.conflictsQuarantinedUnder,
          }
        : undefined;
      const commitNote = commitSummary ? describeCommitShortfall(commitSummary) : "";

      const durationMs = Date.now() - startTime;
      const costUsd = settleCost(durationMs, "completed");

      delegationLog.complete(logId, {
        durationMs,
        costUsd,
        resultSummary: captureChannel.getLastResponse().substring(0, 200),
        escalatedFrom,
      });

      eventBus.emit("delegation:completed", {
        parentAgentId: request.parentAgentId,
        subAgentId,
        type: request.type,
        tier,
        model: providerConfig.model,
        success: true,
        durationMs,
        costUsd,
        escalated: !!escalatedFrom,
        timestamp: Date.now(),
      });

      const content =
        workerResult?.visibleResponse
        ?? workerResult?.finalSummary
        ?? captureChannel.getLastResponse();
      return {
        content: commitNote ? `${content}\n\n${commitNote}` : content,
        workerResult,
        metadata: {
          model: providerConfig.model,
          tier,
          costUsd,
          durationMs,
          toolsUsed: [],
          escalated: !!escalatedFrom,
          escalatedFrom,
          commit: commitSummary,
        },
      };
    } catch (error) {
      if (active.cancelled) {
        // Cancelled (operator/shutdown) — NOT a timeout. The sub-agent still
        // burned compute until the abort, so it is billed, but the log row
        // keeps the 'cancelled' status cancelDelegation wrote and the event
        // names the cancellation. Before this branch existed the aborted
        // signal routed here as a timeout (audited 2026-09-02).
        const cancelledMs = Date.now() - startTime;
        settleCost(cancelledMs, "cancelled");
        eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId,
          type: request.type,
          reason: "Delegation cancelled",
          timestamp: Date.now(),
        });
      } else if (abortController.signal.aborted) {
        // Timed out — the race rejected via waitForAbort (or a same-tick resolve re-threw).
        // A timed-out delegation still consumed compute: bill it against the parent and
        // persist a TERMINAL 'timeout' status. Previously this lived only in the
        // post-race branch (unreachable when waitForAbort rejects), so the log row stayed
        // 'running' forever and the parent kept delegating for free.
        const timedOutMs = Date.now() - startTime;
        const timedOutCostUsd = settleCost(timedOutMs, "timeout");
        delegationLog.timeout(logId, { durationMs: timedOutMs, costUsd: timedOutCostUsd });
        eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId,
          type: request.type,
          reason: "Delegation timed out",
          timestamp: Date.now(),
        });
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        delegationLog.fail(logId, reason, escalatedFrom);

        eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId,
          type: request.type,
          reason,
          originalTier: escalatedFrom,
          timestamp: Date.now(),
        });
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
      // Commit BEFORE release, same as the two lease sites in
      // background-executor. Without this a delegated sub-agent's file writes
      // go into its lease and are deleted with it — the identical defect, one
      // layer down, and easy to miss because the delegation path has its own
      // lease lifecycle. A no-op when the success path already committed.
      await commitWorkspace();
      await workspaceLease?.release().catch(() => {});
      this.cleanup(subAgentId);
      markSettled();
    }
  }

  // ===========================================================================
  // PRIVATE: HELPERS
  // ===========================================================================

  private resolveTypeConfig(type: string): DelegationTypeConfig {
    const typeConfig = this.opts.config.types.find((t) => t.name === type);
    if (!typeConfig) {
      throw new Error(`Unknown delegation type: "${type}"`);
    }
    return typeConfig;
  }

  /**
   * Single source for a delegated provider's createProvider config, so the
   * sub-agent and candidate-scoring paths can never drift — in particular, both
   * always thread the per-provider base-URL override (the OpenCode Zen→Go leak
   * this guards against) and the same credential/auth resolution.
   */
  private buildDelegationProviderConfig(name: string, model: string | undefined): ProviderConfig {
    const credential = this.opts.providerCredentials?.[name];
    return {
      name,
      apiKey: credential?.apiKey ?? this.opts.apiKeys[name],
      openaiAuthMode: credential?.openaiAuthMode,
      openaiChatgptAuthFile: credential?.openaiChatgptAuthFile,
      openaiSubscriptionAccessToken: credential?.openaiSubscriptionAccessToken,
      openaiSubscriptionAccountId: credential?.openaiSubscriptionAccountId,
      model,
      baseUrl: this.opts.providerBaseUrls?.[name],
    };
  }

  private resolveDelegationProviderConfig(
    tier: ModelTier,
    typeConfig: DelegationTypeConfig,
  ): ResolvedDelegationProviderConfig {
    const configured = this.opts.tierRouter.resolveProviderConfig(tier);
    const normalizedName = configured.name.trim().toLowerCase();

    if (normalizedName && normalizedName !== "auto" && this.isDelegationProviderAvailable(normalizedName)) {
      return {
        name: normalizedName,
        model: configured.model || this.getDefaultModelForProvider(normalizedName),
      };
    }

    const dynamic = this.resolveDynamicProviderConfig(tier, typeConfig);
    if (dynamic) {
      return dynamic;
    }

    if (!normalizedName || normalizedName === "auto") {
      throw new Error(`Could not resolve delegation provider for tier "${tier}"`);
    }

    return {
      name: normalizedName,
      model: configured.model || this.getDefaultModelForProvider(normalizedName),
    };
  }

  private resolveDynamicProviderConfig(
    tier: ModelTier,
    typeConfig: DelegationTypeConfig,
  ): ResolvedDelegationProviderConfig | null {
    const candidates = this.buildDelegationCandidates();
    if (candidates.length === 0) {
      return null;
    }

    const workload = this.inferDelegationWorkload(typeConfig.name, tier);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: this.scoreDelegationCandidate(tier, workload, candidate),
      }))
      .sort((left, right) => right.score - left.score);

    const top = ranked[0]?.candidate;
    if (!top) {
      return null;
    }

    return {
      name: top.name,
      model: top.model,
    };
  }

  private buildDelegationCandidates(): Array<{
    name: string;
    model: string;
    provider: ReturnType<typeof createProvider>;
  }> {
    const names = new Set<string>();
    for (const name of this.opts.verifiedLocalProviders ?? []) {
      const normalized = name.trim().toLowerCase();
      if (normalized) {
        names.add(normalized);
      }
    }

    for (const name of Object.keys(this.opts.providerCredentials ?? {})) {
      const normalized = name.trim().toLowerCase();
      if (!normalized || normalized === "anthropic") continue;
      if (this.isDelegationProviderAvailable(normalized)) {
        names.add(normalized);
      }
    }

    const candidates: Array<{
      name: string;
      model: string;
      provider: ReturnType<typeof createProvider>;
    }> = [];

    for (const name of names) {
      try {
        const model = this.getDefaultModelForProvider(name);
        const provider = createProvider(this.buildDelegationProviderConfig(name, model));
        candidates.push({
          name,
          model,
          provider,
        });
      } catch {
        // Skip unusable candidates and keep scanning for a viable worker.
      }
    }

    return candidates;
  }

  private getDefaultModelForProvider(name: string): string {
    for (const spec of Object.values(this.opts.config.tiers)) {
      const normalized = spec.trim();
      if (!normalized) continue;
      const colon = normalized.indexOf(":");
      if (colon === -1) continue;
      const providerName = normalized.slice(0, colon).trim().toLowerCase();
      const model = normalized.slice(colon + 1).trim();
      if (providerName === name && model) {
        return model;
      }
    }

    // The deployment's configured model for this provider wins over any
    // preset: presets carry PAID defaults, and a tier spec without an
    // explicit model must not silently upgrade the account's plan.
    const configuredModel = this.opts.providerModels?.[name];
    if (configuredModel) return configuredModel;
    if (name === "claude" || name === "anthropic") {
      return "claude-sonnet-4-6-20250514";
    }
    const preset = PROVIDER_PRESETS[name]?.defaultModel;
    if (preset) return preset;
    // Refuse to emit the literal "default" model id — the endpoint rejects it with an
    // opaque error and the misconfig is invisible. Surface it at resolution time.
    throw new Error(
      `No model configured for delegation provider "${name}". Add it to config.delegation.tiers ` +
        `(e.g. "${name}:<model-id>") or to PROVIDER_PRESETS.`,
    );
  }

  private isVerifiedLocalProvider(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return (this.opts.verifiedLocalProviders ?? []).some((provider) => provider.trim().toLowerCase() === normalized);
  }

  private isDelegationProviderAvailable(name: string): boolean {
    if (this.isVerifiedLocalProvider(name)) {
      return true;
    }

    // Skip providers in health cooldown to avoid hammering overloaded endpoints
    if (!ProviderHealthRegistry.getInstance().isAvailable(name)) {
      return false;
    }
    if (name === "claude" || name === "anthropic") {
      return Boolean(
        this.opts.providerCredentials?.claude?.apiKey
        || this.opts.providerCredentials?.anthropic?.apiKey
        || (
          this.opts.providerCredentials?.claude?.anthropicAuthMode === "claude-subscription"
          && this.opts.providerCredentials?.claude?.anthropicAuthToken
        )
        || (
          this.opts.providerCredentials?.anthropic?.anthropicAuthMode === "claude-subscription"
          && this.opts.providerCredentials?.anthropic?.anthropicAuthToken
        )
        || this.opts.apiKeys.claude
        || this.opts.apiKeys.anthropic,
      );
    }
    if (name === "openai") {
      const credential = this.opts.providerCredentials?.openai;
      return Boolean(
        credential?.apiKey
        || credential?.openaiAuthMode === "chatgpt-subscription"
        || credential?.openaiChatgptAuthFile
        || (credential?.openaiSubscriptionAccessToken && credential?.openaiSubscriptionAccountId)
        || this.opts.apiKeys.openai,
      );
    }
    return Boolean(this.opts.providerCredentials?.[name]?.apiKey || this.opts.apiKeys[name]);
  }

  private inferDelegationWorkload(typeName: string, tier: ModelTier): ProviderWorkload {
    const normalized = typeName.trim().toLowerCase();
    if (normalized.includes("review")) return "review";
    if (normalized.includes("analysis")) return "analysis";
    if (normalized.includes("document")) return "documentation";
    if (normalized.includes("implement") || normalized.includes("code")) return "implementation";
    if (normalized.includes("debug")) return "debugging";
    if (normalized.includes("plan")) return "planning";

    switch (tier) {
      case "cheap":
        return "documentation";
      case "standard":
        return "implementation";
      case "premium":
        return "planning";
      default:
        return "coordination";
    }
  }

  private scoreDelegationCandidate(
    tier: ModelTier,
    workload: ProviderWorkload,
    candidate: {
      name: string;
      model: string;
      provider: ReturnType<typeof createProvider>;
    },
  ): number {
    const snapshot = getProviderIntelligenceSnapshot(
      candidate.name,
      candidate.model,
      this.modelIntelligence,
      candidate.provider.capabilities,
      candidate.provider.name,
    );
    const workloadScore = snapshot.workloadScores[workload] ?? 0.5;
    const contextScore = Math.min(snapshot.contextWindow / 1_000_000, 1);
    const reasoningScore = snapshot.capabilities.supportsThinking ? 1 : 0.45;
    const toolScore = snapshot.capabilities.supportsToolCalling ? 1 : 0.25;
    const cheapness = this.getCheapnessScore(snapshot, candidate.name);
    const maxOutputScore = Math.min(
      (candidate.provider.capabilities.maxTokens ?? 8_000) / 64_000,
      1,
    );

    if (tier === "local") {
      const localBonus = this.isVerifiedLocalProvider(candidate.name) ? 1 : 0;
      return (localBonus * 0.7) + (cheapness * 0.2) + (workloadScore * 0.1);
    }

    if (tier === "cheap") {
      return (cheapness * 0.45) + (workloadScore * 0.35) + (toolScore * 0.2);
    }

    if (tier === "premium") {
      return (workloadScore * 0.35) + (reasoningScore * 0.2) + (contextScore * 0.15) + (toolScore * 0.1) + (maxOutputScore * 0.2);
    }

    return (workloadScore * 0.4) + (reasoningScore * 0.2) + (toolScore * 0.2) + (cheapness * 0.2);
  }

  private getCheapnessScore(
    snapshot: ReturnType<typeof getProviderIntelligenceSnapshot>,
    providerName: string,
  ): number {
    if (this.isVerifiedLocalProvider(providerName)) {
      return 1;
    }
    const totalPrice =
      (snapshot.economics.inputPricePerMillion ?? 0) +
      (snapshot.economics.outputPricePerMillion ?? 0);

    if (snapshot.economics.inputPricePerMillion === undefined && snapshot.economics.outputPricePerMillion === undefined) {
      return 0.5;
    }
    if (totalPrice <= 1) return 1;
    if (totalPrice <= 4) return 0.8;
    if (totalPrice <= 10) return 0.6;
    if (totalPrice <= 20) return 0.35;
    return 0.2;
  }

  /**
   * Atomically check concurrency limit and reserve a slot in one operation.
   * Eliminates the TOCTOU race between the old separate check + increment calls.
   */
  private acquireConcurrencySlot(parentAgentId: string): void {
    const current = this.parentConcurrency.get(parentAgentId) ?? 0;
    if (current >= this.opts.config.maxConcurrentPerParent) {
      throw new Error(
        `Max concurrent delegations (${this.opts.config.maxConcurrentPerParent}) exceeded for parent ${parentAgentId}`,
      );
    }
    this.parentConcurrency.set(parentAgentId, current + 1);
  }

  private decrementConcurrency(parentAgentId: string): void {
    const current = this.parentConcurrency.get(parentAgentId) ?? 0;
    this.parentConcurrency.set(parentAgentId, Math.max(0, current - 1));
  }

  private cleanup(subAgentId: string): void {
    // Remove the active-delegation entry only. The concurrency slot is owned and
    // released by executeWithEscalation's per-attempt finally; releasing it here
    // too would double-decrement.
    this.activeDelegations.delete(subAgentId);
  }

  private buildSubAgentTools(_currentDepth: number): ITool[] {
    // Strip the parent's bound delegation tools — they carry the wrong parentAgentId
    // and depth. Sub-agents are deliberately given NO fresh delegate_ tools, so
    // delegation is single-level by design: config.delegation.maxDepth > 1 currently
    // has no effect (nested/recursive delegation is intentionally not wired). This is
    // the single place to revisit — call createDelegationTools(..., _currentDepth,
    // maxDepth) here — if nested delegation is ever implemented.
    //
    // swarm_* is stripped for the SAME reason and must be named explicitly: it is a
    // fan-out delegation surface bound to the parent's agent id and depth, so handing
    // it down gives the sub-agent exactly the next generation the depth rule refuses —
    // N of them at once. It stayed out of the handed-down set only because
    // stage-agents snapshots parentTools before the swarm tool is registered; any
    // reordering there silently re-armed nested fan-out (audited 2026-09-02).
    return this.opts.parentTools.filter(
      (t) => !t.name.startsWith("delegate_") && !t.name.startsWith("swarm_"),
    );
  }

  /**
   * Estimate delegation cost by tier as a conservative approximation.
   * Per-second rates assume typical LLM API pricing.
   *
   * FALLBACK ONLY — used when a run reported no token usage at all. Measured
   * usage (see the onUsage sink in executeSingleDelegation) is the norm.
   */
  private estimateDelegationCost(tier: ModelTier, durationMs: number): number {
    const costPerSecond: Record<ModelTier, number> = {
      local: 0,
      cheap: 0.0001,     // ~$0.36/hr
      standard: 0.0005,  // ~$1.80/hr
      premium: 0.002,    // ~$7.20/hr
    };
    return (durationMs / 1000) * (costPerSecond[tier] ?? 0);
  }

  /**
   * Returns a promise that rejects when the AbortSignal fires.
   *
   * Uses { once: true } to avoid listener leaks on normal completion.
   * Mirrors the enriched error-context pattern used in
   * `supervisor-dispatcher.executeWithTimeout`: the rejection message
   * includes the caller-supplied label and the AbortSignal.reason when
   * available, so Promise.race timeouts produce actionable diagnostics
   * instead of a bare "Delegation aborted" string.
   */
  private waitForAbort(signal: AbortSignal, label = "delegation"): Promise<never> {
    const describe = (reason: unknown): string => {
      if (reason instanceof Error) return reason.message;
      if (typeof reason === "string" && reason.length > 0) return reason;
      return "aborted";
    };
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(`Aborted: ${label} (${describe(signal.reason)})`));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error(`Aborted: ${label} (${describe(signal.reason)})`));
        },
        { once: true },
      );
    });
  }
}

/**
 * The line appended to a delegation's content when the workspace commit did
 * NOT apply everything the sub-agent produced. Empty when nothing fell short,
 * so a clean commit adds nothing to the sub-agent's own report.
 */
function describeCommitShortfall(commit: NonNullable<DelegationResult["metadata"]["commit"]>): string {
  const parts: string[] = [];
  if (commit.conflicts.length > 0) {
    const where = commit.quarantinedUnder
      ? `the sub-agent's version is quarantined under ${commit.quarantinedUnder}`
      : "the sub-agent's version could NOT be quarantined and is gone";
    parts.push(
      `NOT applied to the project (the project copy changed while the sub-agent ran; ${where}): ` +
        commit.conflicts.join(", "),
    );
  }
  if (commit.failed.length > 0) {
    parts.push(`NOT applied to the project (could not be processed by the commit): ${commit.failed.join(", ")}`);
  }
  if (commit.removed.length > 0) {
    parts.push(
      `Deleted in the sub-agent's workspace but LEFT IN PLACE in the project: ${commit.removed.join(", ")}`,
    );
  }
  if (parts.length === 0) return "";
  return `[Workspace commit: ${commit.written} file(s) applied]\n` + parts.join("\n");
}
