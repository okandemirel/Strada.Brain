/**
 * Agent Observation Types
 *
 * Defines the observation stream consumed by AgentCore for autonomous reasoning.
 * Named AgentObservation to avoid collision with learning system's Observation type.
 */

import { randomUUID } from "node:crypto";

/** Sources that can produce observations */
export type ObservationSource =
  | "file-watch"
  | "git"
  | "test"
  | "build"
  | "user"
  | "trigger"
  | "schedule"
  | "task-outcome";

/** A single observation from the environment */
export interface AgentObservation {
  readonly id: string;
  readonly source: ObservationSource;
  readonly priority: number; // 0-100, base priority from source
  readonly summary: string; // Human-readable description
  readonly context: Record<string, unknown>; // Source-specific data
  readonly timestamp: number;
  readonly actionable: boolean; // Can the agent do something about this?
}

/** Factory for creating observations */
export function createObservation(
  source: ObservationSource,
  summary: string,
  opts: {
    priority?: number;
    context?: Record<string, unknown>;
    actionable?: boolean;
  } = {},
): AgentObservation {
  return {
    id: randomUUID(),
    source,
    priority: opts.priority ?? 50,
    summary,
    context: opts.context ?? {},
    timestamp: Date.now(),
    actionable: opts.actionable ?? true,
  };
}

/** Interface that all observers implement */
export interface Observer {
  readonly name: string;
  /** Collect pending observations (non-blocking, returns immediately) */
  collect(): AgentObservation[];
  /** Start monitoring (if needed) */
  start?(): void;
  /** Stop monitoring and clean up resources */
  stop?(): void;
}
