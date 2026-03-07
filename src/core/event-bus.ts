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
import type { InstinctLifecycleEvent } from "../learning/types.js";

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
// EVENT MAP
// =============================================================================

/** Map of event names to their payload types */
export interface LearningEventMap {
  "tool:result": ToolResultEvent;
  "instinct:cooling-started": InstinctLifecycleEvent;
  "instinct:deprecated": InstinctLifecycleEvent;
  "instinct:promoted": InstinctLifecycleEvent;
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
