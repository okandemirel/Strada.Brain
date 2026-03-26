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
import type { ProviderCredentialMap } from "../../providers/provider-registry.js";
import { createProvider, PROVIDER_PRESETS } from "../../providers/provider-registry.js";
import { ProviderManager } from "../../providers/provider-manager.js";
import { Orchestrator } from "../../orchestrator.js";
import { getProviderIntelligenceSnapshot, type ProviderWorkload } from "../../providers/provider-knowledge.js";
import { WorkspaceLeaseManager } from "../workspace-lease-manager.js";

// =============================================================================
// OPTIONS
// =============================================================================

export interface DelegationManagerOptions {
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
  readonly preferencesDbPath?: string;
  readonly verifiedLocalProviders?: readonly string[];
  readonly workspaceLeaseManager?: WorkspaceLeaseManager;
  readonly providerRouter?: ConstructorParameters<typeof Orchestrator>[0]["providerRouter"];
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

  constructor(opts: DelegationManagerOptions) {
    this.opts = opts;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Synchronous delegation: spawn a sub-agent, wait for result, return it.
   */
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const { typeConfig, effectiveTier } = this.prepareRequest(request);
    try {
      return await this.executeWithEscalation(request, typeConfig, effectiveTier);
    } catch (error) {
      // Release concurrency slot if executeWithEscalation fails before
      // executeSingleDelegation's finally block handles cleanup
      if (!this.hasActiveForParent(request.parentAgentId)) {
        this.decrementConcurrency(request.parentAgentId);
      }
      throw error;
    }
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
    this.cleanup(subAgentId, delegation.parentAgentId);
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
    try {
      return await this.executeSingleDelegation(request, typeConfig, tier);
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

      // Escalate: retry with next tier
      return this.executeSingleDelegation(request, typeConfig, nextTier, tier);
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
    const providerCredential = this.opts.providerCredentials?.[providerConfig.name];
    const provider = createProvider({
      name: providerConfig.name,
      apiKey: providerCredential?.apiKey ?? this.opts.apiKeys[providerConfig.name],
      openaiAuthMode: providerCredential?.openaiAuthMode,
      openaiChatgptAuthFile: providerCredential?.openaiChatgptAuthFile,
      openaiSubscriptionAccessToken: providerCredential?.openaiSubscriptionAccessToken,
      openaiSubscriptionAccountId: providerCredential?.openaiSubscriptionAccountId,
      model: providerConfig.model,
    });

    const providerManager = new ProviderManager(
      provider,
      this.opts.providerCredentials ?? {},
      undefined,
      this.opts.preferencesDbPath,
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
        streamingEnabled: false,
        defaultLanguage: this.opts.defaultLanguage,
        streamInitialTimeoutMs: this.opts.streamInitialTimeoutMs,
        streamStallTimeoutMs: this.opts.streamStallTimeoutMs,
        stradaDeps: this.opts.stradaDeps,
        stradaConfig: this.opts.stradaConfig,
        providerRouter: this.opts.providerRouter,
      });

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
      if (typeof (orchestrator as Orchestrator & { runWorkerTask?: unknown }).runWorkerTask === "function") {
        workerResult = await Promise.race([
          (
            orchestrator as Orchestrator & {
              runWorkerTask: (request: {
                prompt: string;
                mode: "delegated";
                signal: AbortSignal;
                onProgress: (message: import("../../../tasks/types.js").TaskProgressUpdate) => void;
                chatId: string;
                taskRunId: string;
                channelType: string;
                userId: string;
                workspaceLease?: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;
              }) => Promise<import("../../supervisor/supervisor-types.js").WorkerRunResult>;
            }
          ).runWorkerTask({
            prompt: message.text,
            mode: "delegated",
            signal: abortController.signal,
            onProgress: () => {},
            chatId: message.chatId,
            taskRunId: subAgentId,
            channelType: message.channelType,
            userId: message.userId ?? "sub-agent",
            workspaceLease,
          }),
          this.waitForAbort(abortController.signal),
        ]);
      } else {
        // Execute with abort awareness
        await Promise.race([
          orchestrator.handleMessage(message),
          this.waitForAbort(abortController.signal),
        ]);
      }

      // Check if aborted (timeout fired)
      if (abortController.signal.aborted) {
        delegationLog.timeout(logId);
        eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId,
          type: request.type,
          reason: "Delegation timed out",
          timestamp: Date.now(),
        });
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
      // Only log failure if not already handled (timeout)
      if (!abortController.signal.aborted) {
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
      await workspaceLease?.release().catch(() => {});
      this.cleanup(subAgentId, request.parentAgentId);
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
        const credential = this.opts.providerCredentials?.[name];
        const model = this.getDefaultModelForProvider(name);
        const provider = createProvider({
          name,
          apiKey: credential?.apiKey ?? this.opts.apiKeys[name],
          openaiAuthMode: credential?.openaiAuthMode,
          openaiChatgptAuthFile: credential?.openaiChatgptAuthFile,
          openaiSubscriptionAccessToken: credential?.openaiSubscriptionAccessToken,
          openaiSubscriptionAccountId: credential?.openaiSubscriptionAccountId,
          model,
        });
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
    return PROVIDER_PRESETS[name]?.defaultModel ?? "default";
  }

  private isVerifiedLocalProvider(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return (this.opts.verifiedLocalProviders ?? []).some((provider) => provider.trim().toLowerCase() === normalized);
  }

  private isDelegationProviderAvailable(name: string): boolean {
    if (this.isVerifiedLocalProvider(name)) {
      return true;
    }
    if (name === "claude" || name === "anthropic") {
      return Boolean(
        this.opts.providerCredentials?.claude?.apiKey
        || this.opts.providerCredentials?.anthropic?.apiKey
        || this.opts.providerCredentials?.claude?.anthropicAuthToken
        || this.opts.providerCredentials?.anthropic?.anthropicAuthToken
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
      undefined,
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

  private cleanup(subAgentId: string, parentAgentId: string): void {
    this.activeDelegations.delete(subAgentId);
    this.decrementConcurrency(parentAgentId);
  }

  private buildSubAgentTools(_currentDepth: number): ITool[] {
    // Always filter out parent's bound delegation tools — they carry the wrong
    // parentAgentId and depth. Fresh delegation tools for the sub-agent are
    // created by the delegation factory in AgentManager if depth allows.
    return this.opts.parentTools.filter((t) => !t.name.startsWith("delegate_"));
  }

  /**
   * Check if any active delegation exists for the given parent.
   * Used to avoid double-decrement when prepareRequest reserved a slot
   * but executeSingleDelegation's cleanup already released it.
   */
  private hasActiveForParent(parentAgentId: string): boolean {
    for (const d of this.activeDelegations.values()) {
      if (d.parentAgentId === parentAgentId) return true;
    }
    return false;
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
   * Uses { once: true } to avoid listener leaks on normal completion.
   */
  private waitForAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Delegation aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new Error("Delegation aborted"));
      }, { once: true });
    });
  }
}
