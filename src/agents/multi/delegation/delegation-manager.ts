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
import { getLogger } from "../../../utils/logger.js";
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
import { WorkspaceLeaseManager } from "../workspace-lease-manager.js";
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
}

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
    const { typeConfig, effectiveTier } = this.prepareRequest(request);
    // The concurrency slot reserved by prepareRequest is released inside
    // executeWithEscalation's per-attempt finally, so no compensation is needed
    // here (and adding any would double-release).
    return await this.executeWithEscalation(request, typeConfig, effectiveTier);
  }

  /**
   * Asynchronous delegation: fire-and-forget, emits events when done.
   */
  async delegateAsync(request: DelegationRequest): Promise<void> {
    const { typeConfig, effectiveTier } = this.prepareRequest(request);

    // Events are already emitted inside executeSingleDelegation with correct subAgentId.
    // Only swallow rejection to prevent unhandled promise rejection.
    this.executeWithEscalation(request, typeConfig, effectiveTier).catch(() => {
      // Already logged and emitted inside executeSingleDelegation
    });
  }

  /**
   * Cancel a running delegation by subAgentId.
   */
  cancelDelegation(subAgentId: string): void {
    const delegation = this.activeDelegations.get(subAgentId);
    if (!delegation) return;

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
   * Shutdown: cancel all active delegations.
   */
  async shutdown(): Promise<void> {
    for (const [subAgentId] of this.activeDelegations) {
      this.cancelDelegation(subAgentId);
    }
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
  } {
    const typeConfig = this.resolveTypeConfig(request.type);

    // Health gate: prevent thundering herd against overloaded providers
    const healthRegistry = ProviderHealthRegistry.getInstance();
    // Measure only live chain members: a stale entry for a de-configured
    // provider or a healthy "chain(...)" alias defeated the every(down)
    // reduction — the exact hazard provider-outage.ts documents.
    const memberEntries = [...healthRegistry.getAllEntries()]
      .filter(([name]) => isCurrentChainMemberName(name))
      .map(([, e]) => e);
    if (memberEntries.length > 0) {
      const now = Date.now();
      const allDown = memberEntries.every(
        (e) => e.status === "down" && now < e.cooldownUntil,
      );
      if (allDown) {
        // Only hard-abort when recovery is NOT imminent. When the soonest provider is about
        // to exit a transient cooldown, let delegation proceed — the sub-agent's FallbackChain
        // performs a single bounded wait-for-recovery (the one place the wait lives) instead of
        // failing the whole task on a brief all-cooled blip. The FallbackChain probing guard
        // still prevents a thundering herd of concurrent probes to the recovering provider.
        const recoveryImminent = healthRegistry.suggestRecoveryWaitMs(now) !== null;
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
    if (
      budgetCapUsd !== undefined &&
      this.opts.budgetTracker.isAgentExceeded(parentAgentId, budgetCapUsd)
    ) {
      const usage = this.opts.budgetTracker.getAgentUsage(parentAgentId, budgetCapUsd);
      throw new Error(
        `Parent agent budget exceeded ($${usage.usedUsd.toFixed(2)} / $${budgetCapUsd.toFixed(2)}) — delegation rejected before spawn.`,
      );
    }

    // Atomically check + reserve concurrency slot to prevent TOCTOU race
    this.acquireConcurrencySlot(request.parentAgentId);

    const effectiveTier = this.opts.tierRouter.getTypeEffectiveTier(
      request.type,
      typeConfig.tier,
    );

    return { typeConfig, effectiveTier };
  }

  // ===========================================================================
  // PRIVATE: ESCALATION
  // ===========================================================================

  private async executeWithEscalation(
    request: DelegationRequest,
    typeConfig: DelegationTypeConfig,
    tier: ModelTier,
  ): Promise<DelegationResult> {
    // Attempt 1 — slot reserved by prepareRequest. The inner finally releases it
    // exactly once whether the attempt returns, throws during execution, or
    // throws during setup before executeSingleDelegation's own try is reached —
    // so no caller (delegate/delegateAsync) and no sibling-sensitive guard is
    // needed to compensate.
    try {
      try {
        return await this.executeSingleDelegation(request, typeConfig, tier);
      } finally {
        this.decrementConcurrency(request.parentAgentId);
      }
    } catch (error) {
      // Do not escalate aborted/cancelled/timed-out delegations
      if (
        error instanceof Error &&
        (error.message.includes("aborted") || error.message.includes("timed out"))
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
        return await this.executeSingleDelegation(request, typeConfig, nextTier, tier);
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
      undefined, // modelOverrides
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
    this.activeDelegations.set(subAgentId, {
      abortController,
      logId,
      parentAgentId: request.parentAgentId,
      type: request.type,
      startedAt: startTime,
    });

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

      const durationMs = Date.now() - startTime;
      // Estimate cost from tier as a conservative approximation until
      // real provider token usage tracking is available
      const costUsd = this.estimateDelegationCost(tier, durationMs);

      budgetTracker.recordCost(request.parentAgentId as AgentId, costUsd, {
        model: providerConfig.model,
        tokensIn: 0,
        tokensOut: 0,
      });

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

      return {
        content:
          workerResult?.visibleResponse
          ?? workerResult?.finalSummary
          ?? captureChannel.getLastResponse(),
        workerResult,
        metadata: {
          model: providerConfig.model,
          tier,
          costUsd,
          durationMs,
          toolsUsed: [],
          escalated: !!escalatedFrom,
          escalatedFrom,
        },
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        // Timed out — the race rejected via waitForAbort (or a same-tick resolve re-threw).
        // A timed-out delegation still consumed compute: bill it against the parent and
        // persist a TERMINAL 'timeout' status. Previously this lived only in the
        // post-race branch (unreachable when waitForAbort rejects), so the log row stayed
        // 'running' forever and the parent kept delegating for free.
        const timedOutMs = Date.now() - startTime;
        const timedOutCostUsd = this.estimateDelegationCost(tier, timedOutMs);
        budgetTracker.recordCost(request.parentAgentId as AgentId, timedOutCostUsd, {
          model: providerConfig.model,
          tokensIn: 0,
          tokensOut: 0,
        });
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
      // lease lifecycle.
      if (workspaceLease) {
        await Promise.resolve()
          .then(() => workspaceLease!.commit())
          .then((result) => {
            if (
              result.written.length > 0 ||
              result.conflicts.length > 0 ||
              result.failed.length > 0
            ) {
              getLogger().info("Delegated workspace committed", {
                subAgentId,
                files: result.written.length,
                conflicts: result.conflicts.length,
                failed: result.failed.length,
                quarantinedUnder: result.conflictsQuarantinedUnder,
              });
            }
          })
          .catch((err) => {
            getLogger().error("Delegated workspace commit failed — sub-agent work discarded", {
              subAgentId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      await workspaceLease?.release().catch(() => {});
      this.cleanup(subAgentId);
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
    return this.opts.parentTools.filter((t) => !t.name.startsWith("delegate_"));
  }

  /**
   * Estimate delegation cost by tier as a conservative approximation.
   * Per-second rates assume typical LLM API pricing.
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
