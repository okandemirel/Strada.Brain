/**
 * Agent Core v2 — EventBus public surface (ARCHITECTURE §5.1).
 *
 * The one typed run-scoped stream: the closed `AgentEvent` union, the run-scoped bus with its
 * bounded ring buffer + lossy-newest live sinks, the heartbeat-invariant wait primitive, and
 * the one-variant bridge to the process-wide TypedEventBus. Purely additive — nothing in v1
 * imports this yet (Phase 2 foundation; `AgentRunEvent` widens to `AgentEvent` here).
 */

export type {
  Seq,
  AgentEvent,
  AgentEventBase,
  AgentEventType,
  EmittableEvent,
  ModelDeltaChannel,
  RunStartedEvent,
  RunEndingEvent,
  RunEndedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  PhaseChangedEvent,
  EpochRolledEvent,
  BackoffEvent,
  IntentAckEvent,
  ModelCallStartedEvent,
  ModelDeltaEvent,
  ModelToolCallEvent,
  ModelCallFinishedEvent,
  ToolStartedEvent,
  ToolFinishedEvent,
  NarrativeEvent,
  HeartbeatEvent,
  AskUserEvent,
  ShowPlanEvent,
  ErrorEvent,
  CapabilityEvent,
} from "./agent-event.js";
export { assertNever, isVisibleContent } from "./agent-event.js";

export { createAgentRunEventBus } from "./event-bus.js";
export type {
  AgentRunEventBus,
  AgentRunEventBusOptions,
  LiveSink,
  RingBufferSnapshot,
} from "./event-bus.js";

export { createBoundedSink } from "./bounded-sink.js";
export type { BoundedSinkOptions } from "./bounded-sink.js";

export { guardedSleep, assertEmittedSince } from "./heartbeat-guard.js";

export { createLearningBridgeSink } from "./learning-bridge.js";
