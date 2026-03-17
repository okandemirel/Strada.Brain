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
import { createProvider } from "../../providers/provider-registry.js";
import { ProviderManager } from "../../providers/provider-manager.js";
import { Orchestrator } from "../../orchestrator.js";

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
  readonly stradaDeps: StradaDepsStatus;
  readonly stradaConfig?: Partial<StradaDependencyConfig>;
  readonly parentTools: ITool[];
  readonly apiKeys: Record<string, string | undefined>;
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
    const providerConfig = this.opts.tierRouter.resolveProviderConfig(tier);
    const provider = createProvider({
      name: providerConfig.name,
      apiKey: this.opts.apiKeys[providerConfig.name],
      model: providerConfig.model,
    });

    const providerManager = new ProviderManager(provider, this.opts.apiKeys);
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

    try {
      const orchestrator = new Orchestrator({
        providerManager,
        tools: subAgentTools,
        channel: captureChannel,
        projectPath: this.opts.projectPath,
        readOnly: this.opts.readOnly,
        requireConfirmation: false,
        streamingEnabled: false,
        stradaDeps: this.opts.stradaDeps,
        stradaConfig: this.opts.stradaConfig,
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

      // Execute with abort awareness
      await Promise.race([
        orchestrator.handleMessage(message),
        this.waitForAbort(abortController.signal),
      ]);

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
        content: captureChannel.getLastResponse(),
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
