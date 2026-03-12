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
    this.captured = text;
  }
  async sendMarkdown(_chatId: string, markdown: string): Promise<void> {
    this.captured = markdown;
  }

  getLastResponse(): string {
    return this.captured;
  }
}

// =============================================================================
// DELEGATION MANAGER
// =============================================================================

export class DelegationManager {
  private readonly config: DelegationConfig;
  private readonly tierRouter: TierRouter;
  private readonly delegationLog: DelegationLog;
  private readonly eventBus: IEventBus<LearningEventMap>;
  private readonly budgetTracker: AgentBudgetTracker;
  private readonly projectPath: string;
  private readonly readOnly: boolean;
  private readonly stradaDeps: StradaDepsStatus;
  private readonly parentTools: ITool[];
  private readonly apiKeys: Record<string, string | undefined>;

  /** Active delegations keyed by subAgentId */
  private readonly activeDelegations = new Map<string, ActiveDelegation>();

  /** Active delegation count per parent agent */
  private readonly parentConcurrency = new Map<string, number>();

  constructor(opts: DelegationManagerOptions) {
    this.config = opts.config;
    this.tierRouter = opts.tierRouter;
    this.delegationLog = opts.delegationLog;
    this.eventBus = opts.eventBus;
    this.budgetTracker = opts.budgetTracker;
    this.projectPath = opts.projectPath;
    this.readOnly = opts.readOnly;
    this.stradaDeps = opts.stradaDeps;
    this.parentTools = opts.parentTools;
    this.apiKeys = opts.apiKeys;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Synchronous delegation: spawn a sub-agent, wait for result, return it.
   */
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const typeConfig = this.resolveTypeConfig(request.type);
    this.checkConcurrency(request.parentAgentId);

    const effectiveTier = this.tierRouter.getTypeEffectiveTier(
      request.type,
      typeConfig.tier,
    );

    return this.executeWithEscalation(request, typeConfig, effectiveTier);
  }

  /**
   * Asynchronous delegation: fire-and-forget, emits events when done.
   */
  async delegateAsync(request: DelegationRequest): Promise<void> {
    const typeConfig = this.resolveTypeConfig(request.type);
    this.checkConcurrency(request.parentAgentId);

    const effectiveTier = this.tierRouter.getTypeEffectiveTier(
      request.type,
      typeConfig.tier,
    );

    // Fire and forget
    this.executeWithEscalation(request, typeConfig, effectiveTier)
      .then((result) => {
        this.eventBus.emit("delegation:completed", {
          parentAgentId: request.parentAgentId,
          subAgentId: "async-" + request.type,
          type: request.type,
          tier: result.metadata.tier,
          model: result.metadata.model,
          success: true,
          durationMs: result.metadata.durationMs,
          costUsd: result.metadata.costUsd,
          escalated: result.metadata.escalated,
          timestamp: Date.now(),
        });
      })
      .catch((err) => {
        this.eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId: "async-" + request.type,
          type: request.type,
          reason: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
      });
  }

  /**
   * Cancel a running delegation by subAgentId.
   */
  cancelDelegation(subAgentId: string): void {
    const delegation = this.activeDelegations.get(subAgentId);
    if (!delegation) return;

    delegation.abortController.abort();
    this.delegationLog.cancel(delegation.logId);
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

      const nextTier = this.tierRouter.getEscalationTier(tier);
      if (!nextTier) {
        throw error; // No escalation possible (local or premium)
      }

      // Escalate: retry with next tier
      return this.executeSingleDelegation(
        request,
        typeConfig,
        nextTier,
        tier, // escalatedFrom
      );
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
    const subAgentId = randomUUID();
    const startTime = Date.now();

    // Resolve provider for this tier
    const providerConfig = this.tierRouter.resolveProviderConfig(tier);
    const provider = createProvider({
      name: providerConfig.name,
      apiKey: this.apiKeys[providerConfig.name],
      model: providerConfig.model,
    });

    // Create ProviderManager wrapping the tier-specific provider
    const providerManager = new ProviderManager(provider, this.apiKeys);

    // Build sub-agent tools: filter delegation tools at max depth
    const subAgentTools = this.buildSubAgentTools(request.depth);

    // Build system prompt
    const systemPrompt =
      typeConfig.systemPrompt ??
      `You are a specialized sub-agent for ${typeConfig.name.replace(/_/g, " ")} tasks. Complete the assigned task concisely and return the result. Do not delegate further.`;

    // Set up timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, typeConfig.timeoutMs);

    // Log start
    const logId = this.delegationLog.start({
      parentAgentId: request.parentAgentId,
      subAgentId,
      type: request.type,
      model: providerConfig.model,
      tier,
      depth: request.depth,
    });

    // Track active delegation
    this.activeDelegations.set(subAgentId, {
      abortController,
      logId,
      parentAgentId: request.parentAgentId,
      type: request.type,
      startedAt: startTime,
    });
    this.incrementConcurrency(request.parentAgentId);

    // Emit started event
    this.eventBus.emit("delegation:started", {
      parentAgentId: request.parentAgentId,
      subAgentId,
      type: request.type,
      tier,
      model: providerConfig.model,
      depth: request.depth,
      mode: request.mode,
      timestamp: startTime,
    });

    // Create capture channel to collect sub-agent output
    const captureChannel = new CaptureChannel();

    try {
      // Create sub-agent Orchestrator
      const orchestrator = new Orchestrator({
        providerManager,
        tools: subAgentTools,
        channel: captureChannel,
        projectPath: this.projectPath,
        readOnly: this.readOnly,
        requireConfirmation: false,
        streamingEnabled: false,
        stradaDeps: this.stradaDeps,
      });

      // Build the incoming message
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

      // Check if aborted
      if (abortController.signal.aborted) {
        this.delegationLog.timeout(logId);
        this.eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId,
          type: request.type,
          reason: "Delegation timed out",
          timestamp: Date.now(),
        });
        throw new Error(`Delegation ${request.type} timed out after ${typeConfig.timeoutMs}ms`);
      }

      // Compute duration and cost
      const durationMs = Date.now() - startTime;
      const costUsd = 0; // Cost tracking would come from provider usage stats

      // Record cost on parent budget
      this.budgetTracker.recordCost(request.parentAgentId as AgentId, costUsd, {
        model: providerConfig.model,
        tokensIn: 0,
        tokensOut: 0,
      });

      // Log completion
      this.delegationLog.complete(logId, {
        durationMs,
        costUsd,
        resultSummary: captureChannel.getLastResponse().substring(0, 200),
        escalatedFrom: escalatedFrom ?? undefined,
      });

      // Emit completed event
      this.eventBus.emit("delegation:completed", {
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

      const result: DelegationResult = {
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

      return result;
    } catch (error) {
      // Only log failure if not already handled (timeout)
      if (!abortController.signal.aborted) {
        this.delegationLog.fail(
          logId,
          error instanceof Error ? error.message : String(error),
          escalatedFrom ?? undefined,
        );

        this.eventBus.emit("delegation:failed", {
          parentAgentId: request.parentAgentId,
          subAgentId,
          type: request.type,
          reason: error instanceof Error ? error.message : String(error),
          escalatedFrom,
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
    const typeConfig = this.config.types.find((t) => t.name === type);
    if (!typeConfig) {
      throw new Error(`Unknown delegation type: "${type}"`);
    }
    return typeConfig;
  }

  private checkConcurrency(parentAgentId: string): void {
    const current = this.parentConcurrency.get(parentAgentId) ?? 0;
    if (current >= this.config.maxConcurrentPerParent) {
      throw new Error(
        `Max concurrent delegations (${this.config.maxConcurrentPerParent}) exceeded for parent ${parentAgentId}`,
      );
    }
  }

  private incrementConcurrency(parentAgentId: string): void {
    const current = this.parentConcurrency.get(parentAgentId) ?? 0;
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

  private buildSubAgentTools(currentDepth: number): ITool[] {
    // The sub-agent's effective depth is currentDepth + 1.
    // If that reaches maxDepth, exclude delegation tools so the sub-agent
    // cannot delegate further (depth enforcement via tool exclusion).
    if (currentDepth + 1 >= this.config.maxDepth) {
      return this.parentTools.filter((t) => !t.name.startsWith("delegate_"));
    }
    return [...this.parentTools];
  }

  /**
   * Returns a promise that rejects when the AbortSignal fires.
   */
  private waitForAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Delegation aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new Error("Delegation aborted"));
      });
    });
  }
}
