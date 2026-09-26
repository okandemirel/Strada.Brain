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
import type {
  DelegationStartedEvent,
  DelegationCompletedEvent,
  DelegationFailedEvent,
} from "../agents/multi/delegation/delegation-types.js";

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
  /**
   * Feeds error-pattern learning (`error_patterns` rows and "recurring error"
   * instincts). LRN-19: a structured signature only — category from the closed
   * enum, a strict diagnostic code, a project-relative file and a line, with a
   * templated message (see learning/error-signature.ts). Never tool output: it
   * can be attacker-influenced and learned instincts reach prompts. The
   * learning pipeline re-validates it, so anything else a producer puts here
   * is dropped.
   */
  readonly errorDetails?: {
    readonly code?: string;
    readonly category: string;
    readonly message: string;
    readonly file?: string;
    readonly line?: number;
  };
  readonly retryCount?: number;
  /**
   * Round 10 #13: WHICH RUN produced this result. `sessionId` carries the CHAT
   * id, and sibling wave nodes share one chat on one Orchestrator — so without
   * this the learning pipeline could not tell two concurrent runs apart, and the
   * first to finish settled (and deleted) its sibling's credit. Absent off-run
   * (v1 revert paths, tests), where the chat is the only honest scope.
   */
  readonly taskRunId?: string;
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
// CONSOLIDATION EVENT TYPES (Phase 25)
// =============================================================================

/** Emitted when a memory consolidation cycle starts */
export interface ConsolidationStartedEvent {
  readonly timestamp: number;
  readonly agentId?: string;
}

/** Emitted when a memory consolidation cycle completes */
export interface ConsolidationCompletedEvent {
  readonly processed: number;
  readonly clustersFound: number;
  readonly costUsd: number;
  readonly timestamp: number;
  readonly agentId?: string;
}

/** Emitted when a memory consolidation cycle is interrupted by user activity */
export interface ConsolidationInterruptedEvent {
  readonly processed: number;
  readonly remaining: number;
  readonly timestamp: number;
  readonly agentId?: string;
}

// =============================================================================
// FEEDBACK EVENT TYPES
// =============================================================================

/** Emitted when a user reacts to a message (thumbs up/down, emoji, button) */
export interface FeedbackReactionEvent {
  readonly type: "thumbs_up" | "thumbs_down";
  readonly instinctIds: string[];
  readonly userId?: string;
  readonly source: "reaction" | "button";
  readonly channel: string;
  readonly timestamp: number;
  /**
   * LRN-20b: the run that produced the reacted-to response, as recorded when it
   * was sent. Trust signals are keyed by it; without it none is recorded.
   */
  readonly runId?: string;
  /** LRN-20b: who sent the message that run answered. Only their reaction moves trust. */
  readonly requesterUserId?: string;
  /** LRN-20b: the warn-tier rules the response's footer named, with the tool each warned before. */
  readonly warnedRules?: ReadonlyArray<{ readonly instinctId: string; readonly toolName: string }>;
}

// =============================================================================
// EVENT MAP
// =============================================================================

/** Map of event names to their payload types */
export interface LearningEventMap {
  [key: string]: unknown;
  "tool:result": ToolResultEvent;
  "feedback:reaction": FeedbackReactionEvent;
  "instinct:cooling-started": InstinctLifecycleEvent;
  "instinct:deprecated": InstinctLifecycleEvent;
  "instinct:promoted": InstinctLifecycleEvent;
  /** A permanent instinct held out of use after repeated negative evidence. */
  "instinct:quarantined": InstinctLifecycleEvent;
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
  "agent:started": AgentLifecycleEvent;
  "agent:stopped": AgentLifecycleEvent;
  "agent:budget_exceeded": AgentBudgetEvent;
  "agent:evicted": AgentLifecycleEvent;
  "delegation:started": DelegationStartedEvent;
  "delegation:completed": DelegationCompletedEvent;
  "delegation:failed": DelegationFailedEvent;
  "consolidation:started": ConsolidationStartedEvent;
  "consolidation:completed": ConsolidationCompletedEvent;
  "consolidation:interrupted": ConsolidationInterruptedEvent;
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

/** A failing listener is reported at warn at most this often per event. */
const LISTENER_ERROR_WARN_INTERVAL_MS = 60_000;

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

  /**
   * Number of listeners currently subscribed to `event` (0 after shutdown).
   * Lets an emitter distinguish "delivered to a consumer" from "emitted into
   * the void" — a control-plane ack must measure the former (audited 2026-09-02).
   */
  listenerCount<K extends keyof TMap & string>(event: K): number {
    if (this.stopped) return 0;
    return this.emitter.listenerCount(event);
  }

  on<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void | Promise<void>,
  ): void {
    // One subscription per listener: a second on() used to add a second
    // wrapper that off() could never reach, so it stayed live forever (COR-23).
    if (this.listenerMap.get(event)?.has(listener)) return;
    const wrapped: AnyListener = (payload: unknown) => {
      this.inflight++;
      try {
        const result = listener(payload as TMap[K]);
        if (result && typeof (result as Promise<void>).then === "function") {
          // Async listener -- track the promise
          (result as Promise<void>)
            .catch((error: unknown) => {
              this.logError(event, error);
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
        this.logError(event, error);
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

  /** When each event last reported a listener error at warn level. */
  private readonly lastListenerErrorWarnAt = new Map<string, number>();

  private logError(event: string, error: unknown): void {
    // A subscriber that throws on every event was invisible at LOG_LEVEL=info
    // (COR-23): warn, at most once a minute per event, the rest at debug.
    const now = Date.now();
    const lastWarn = this.lastListenerErrorWarnAt.get(event);
    const warn = lastWarn === undefined || now - lastWarn >= LISTENER_ERROR_WARN_INTERVAL_MS;
    if (warn) this.lastListenerErrorWarnAt.set(event, now);
    try {
      // Dynamic import to avoid issues in test environments
      void import("../utils/logger.js").then(({ getLogger }) => {
        const meta = { event, error: error instanceof Error ? error.message : String(error) };
        if (warn) getLogger().warn("TypedEventBus: listener error", meta);
        else getLogger().debug("TypedEventBus: listener error", meta);
      }).catch(() => {
        // Logger unavailable -- silently ignore
      });
    } catch {
      // Logger unavailable -- silently ignore
    }
  }
}
