/**
 * TypedEventBus -- Typed event bus built on Node.js EventEmitter
 *
 * Provides:
 * - IEventEmitter<TMap>: emit-only interface (given to orchestrator)
 * - IEventBus<TMap>: full interface with on/off/shutdown (given to learning pipeline)
 * - TypedEventBus<TMap>: concrete implementation
 * - LearningEventMap: event name -> payload type mapping
 * - ToolResultEvent: rich tool outcome payload
 *
 * Listener errors are caught and logged at debug level (log-and-continue).
 * Async listeners are tracked for graceful shutdown drain.
 */

import { EventEmitter } from "node:events";
import type {
  InstinctLifecycleEvent,
  InstinctScopeEvent,
  InstinctMergedEvent,
  InstinctAgeExpiredEvent,
} from "../learning/types.js";
import type { GoalLifecycleEvent } from "../goals/types.js";
import type { RollbackReport } from "../learning/chains/chain-types.js";
import type { AgentLifecycleEvent, AgentBudgetEvent } from "../agents/multi/agent-types.js";

// =============================================================================
// EVENT PAYLOAD TYPES
// =============================================================================

/**
 * Rich tool result event payload.
 * errorDetails is defined inline to keep core self-contained
 * (avoids coupling src/core/ to src/learning/types.ts).
 */
export interface ToolResultEvent {
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly success: boolean;
  readonly errorDetails?: {
    readonly code?: string;
    readonly category: string;
    readonly message: string;
  };
  readonly retryCount?: number;
  readonly appliedInstinctIds?: string[];
  readonly timestamp: number;
}

// =============================================================================
// CHAIN EVENT PAYLOAD TYPES
// =============================================================================

/** Emitted when a new tool chain pattern is detected and synthesized */
export interface ChainDetectedEvent {
  readonly chainName: string;
  readonly toolSequence: string[];
  readonly occurrences: number;
  readonly successRate: number;
  readonly instinctId: string;
  readonly timestamp: number;
}

/** Emitted when a composite tool chain is executed */
export interface ChainExecutionEvent {
  readonly chainName: string;
  readonly success: boolean;
  readonly stepResults: Array<{
    readonly tool: string;
    readonly success: boolean;
    readonly durationMs: number;
  }>;
  readonly totalDurationMs: number;
  readonly timestamp: number;
  /** Number of parallel branches in this execution (V2) */
  readonly parallelBranches?: number;
  /** Steps cancelled due to sibling failure (V2) */
  readonly cancelledSteps?: string[];
  /** Rollback report if rollback was triggered (V2) */
  readonly rollbackReport?: RollbackReport;
  /** Whether forward-recovery was used instead of rollback (V2) */
  readonly forwardRecovery?: boolean;
}

/** Emitted when a chain is invalidated (low success rate, aged out, etc.) */
export interface ChainInvalidatedEvent {
  readonly chainName: string;
  readonly reason: string;
  readonly timestamp: number;
}

/** Emitted when a chain rollback is executed after failure */
export interface ChainRollbackEvent {
  readonly chainName: string;
  readonly failedStep: string;
  readonly compensationResults: Array<{
    readonly stepId: string;
    readonly tool: string;
    readonly success: boolean;
    readonly durationMs: number;
    readonly state: "rolledBack" | "rollbackFailed";
  }>;
  readonly totalDurationMs: number;
  readonly timestamp: number;
}

/** Emitted after post-synthesis validation of a chain */
export interface ChainValidatedEvent {
  readonly chainName: string;
  readonly validationCount: number;
  readonly resultingConfidence: number;
  readonly deprecated: boolean;
  readonly timestamp: number;
}

// =============================================================================
// MEMORY RE-RETRIEVAL EVENT TYPES (Phase 17)
// =============================================================================

/** Emitted when memory re-retrieval completes during a conversation */
export interface MemoryReRetrievedEvent {
  readonly sessionId: string;
  readonly reason: "periodic" | "topic_shift";
  readonly newMemoryCount: number;
  readonly newRagCount: number;
  readonly newInsightCount: number;
  readonly durationMs: number;
  readonly retrievalNumber: number;
  readonly timestamp: number;
}

/** Emitted when a topic shift is detected during conversation */
export interface MemoryTopicShiftedEvent {
  readonly sessionId: string;
  readonly cosineDistance: number;
  readonly threshold: number;
  readonly previousTopic: string;
  readonly currentTopic: string;
  readonly timestamp: number;
}

// =============================================================================
// GOAL RE-DECOMPOSITION EVENT TYPES (Phase 16)
// =============================================================================

/** Emitted when a goal node is re-decomposed into sub-goals */
export interface GoalRedecomposedEvent {
  readonly rootId: string;
  readonly nodeId: string;
  readonly task: string;
  readonly newNodeCount: number;
  readonly timestamp: number;
}

/** Emitted when a goal node execution is retried */
export interface GoalRetryEvent {
  readonly rootId: string;
  readonly nodeId: string;
  readonly task: string;
  readonly attempt: number;
  readonly timestamp: number;
}

// =============================================================================
// EVENT MAP
// =============================================================================

/** Map of event names to their payload types */
export interface LearningEventMap {
  "tool:result": ToolResultEvent;
  "instinct:cooling-started": InstinctLifecycleEvent;
  "instinct:deprecated": InstinctLifecycleEvent;
  "instinct:promoted": InstinctLifecycleEvent;
  "goal:status-changed": GoalLifecycleEvent;
  "chain:detected": ChainDetectedEvent;
  "chain:executed": ChainExecutionEvent;
  "chain:invalidated": ChainInvalidatedEvent;
  "chain:rollback": ChainRollbackEvent;
  "chain:validated": ChainValidatedEvent;
  "instinct:scope_promoted": InstinctScopeEvent;
  "instinct:merged": InstinctMergedEvent;
  "instinct:age_expired": InstinctAgeExpiredEvent;
  "goal:redecomposed": GoalRedecomposedEvent;
  "goal:retry": GoalRetryEvent;
  "memory:re_retrieved": MemoryReRetrievedEvent;
  "memory:topic_shifted": MemoryTopicShiftedEvent;
  "agent:created": AgentLifecycleEvent;
  "agent:stopped": AgentLifecycleEvent;
  "agent:budget_exceeded": AgentBudgetEvent;
  "agent:evicted": AgentLifecycleEvent;
}

// =============================================================================
// INTERFACES
// =============================================================================

/** Emit-only interface -- given to orchestrator (cannot subscribe) */
export interface IEventEmitter<
  TMap extends Record<string, unknown> = LearningEventMap,
> {
  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): void;
}

/** Full bus interface -- given to learning pipeline (can subscribe) */
export interface IEventBus<
  TMap extends Record<string, unknown> = LearningEventMap,
> extends IEventEmitter<TMap> {
  on<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void | Promise<void>,
  ): void;
  off<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void | Promise<void>,
  ): void;
  shutdown(): Promise<void>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

type AnyListener = (...args: unknown[]) => void;

export class TypedEventBus<
  TMap extends Record<string, unknown> = LearningEventMap,
> implements IEventBus<TMap>
{
  private readonly emitter = new EventEmitter();
  private stopped = false;
  private inflight = 0;
  private drainResolvers: Array<() => void> = [];

  /** Map [event][listener] -> wrapped listener so off() can find the right one */
  private readonly listenerMap = new Map<string, Map<Function, AnyListener>>();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): void {
    if (this.stopped) return;
    this.emitter.emit(event, payload);
  }

  on<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void | Promise<void>,
  ): void {
    const wrapped: AnyListener = (payload: unknown) => {
      this.inflight++;
      try {
        const result = listener(payload as TMap[K]);
        if (result && typeof (result as Promise<void>).then === "function") {
          // Async listener -- track the promise
          (result as Promise<void>)
            .catch((error: unknown) => {
              this.logError(error);
            })
            .finally(() => {
              this.inflight--;
              this.checkDrain();
            });
        } else {
          this.inflight--;
          this.checkDrain();
        }
      } catch (error: unknown) {
        // Sync listener threw -- catch and log
        this.inflight--;
        this.logError(error);
        this.checkDrain();
      }
    };

    let eventMap = this.listenerMap.get(event);
    if (!eventMap) {
      eventMap = new Map();
      this.listenerMap.set(event, eventMap);
    }
    eventMap.set(listener, wrapped);
    this.emitter.on(event, wrapped);
  }

  off<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void | Promise<void>,
  ): void {
    const eventMap = this.listenerMap.get(event);
    const wrapped = eventMap?.get(listener);
    if (wrapped) {
      this.emitter.off(event, wrapped);
      eventMap!.delete(listener);
    }
    // If listener was never registered, silently ignore (no throw)
  }

  async shutdown(): Promise<void> {
    this.stopped = true;

    // Wait for all in-flight async listeners to complete
    if (this.inflight > 0) {
      await new Promise<void>((resolve) => {
        this.drainResolvers.push(resolve);
      });
    }

    this.emitter.removeAllListeners();
    this.listenerMap.clear();
  }

  private checkDrain(): void {
    if (this.inflight === 0 && this.drainResolvers.length > 0) {
      const resolvers = this.drainResolvers.splice(0);
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  private logError(error: unknown): void {
    try {
      // Dynamic import to avoid issues in test environments
      void import("../utils/logger.js").then(({ getLogger }) => {
        getLogger().debug("TypedEventBus: listener error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }).catch(() => {
        // Logger unavailable -- silently ignore
      });
    } catch {
      // Logger unavailable -- silently ignore
    }
  }
}
