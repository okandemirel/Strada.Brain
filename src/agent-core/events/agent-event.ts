/**
 * Agent Core v2 — AgentEvent: the one typed stream (ARCHITECTURE §5.1, §1.2).
 *
 * Closed discriminated union, JSON-serializable BY CONSTRUCTION (no Error objects, no
 * functions, no class instances on the wire — errors are pre-stringified). Every member
 * carries the run envelope { runId, seq, ts, parentRunId? }. `seq` is assigned INSIDE the
 * bus under a per-run lock (callers MUST NOT set it; the bus overwrites). Exhaustively
 * switched via assertNever.
 *
 * In Phase 2, runner/agent-runner.ts's `AgentRunEvent` (= TaskProgressUpdate today) widens
 * to THIS union. The `narrative` variant carries v1's TaskProgressSignal verbatim so the
 * background onProgress stream survives the swap unchanged.
 *
 * VISIBILITY IS A SINK DECISION, NEVER AN EVENT FIELD. The same neutral emission is rendered
 * as live tokens by the web sink, throttled summaries by the chat sink, recorded wholesale by
 * the observability sink. No event carries "show this" / "hide this".
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet (Phase 2 foundation).
 */

import type { TaskProgressSignal, TaskProgressUpdate } from "../../tasks/types.js";
import type { CancelReason } from "../control/cancel-reason.js";
import type { AgentPhase } from "../../agents/agent-state.js";
import type { StopReason, TokenUsage } from "../../agents/providers/provider-core.interface.js";
import type { TerminalStatus } from "../runner/agent-runner.js";

/** Monotonic run-local sequence; assigned by the bus, never by emitters. */
export type Seq = number;

/** The envelope every event carries. `seq`/`ts` are stamped by the bus on emit. */
export interface AgentEventBase {
  readonly runId: string;
  /** Gap-free, total-ordered within a run. Stamped by the bus under the per-run lock. */
  readonly seq: Seq;
  /** Epoch ms, stamped by the bus from the injected clock. */
  readonly ts: number;
  /** Set on child runs (delegated / supervisor-node) — shares the parent's runId tree. */
  readonly parentRunId?: string;
}

/** Which logical channel a model delta belongs to. Only "answer" is visible content. */
export type ModelDeltaChannel = "answer" | "reasoning" | "tool-args";

// ── Lifecycle ────────────────────────────────────────────────────────────────
export interface RunStartedEvent extends AgentEventBase {
  readonly type: "run.started";
  readonly prompt: string;
  readonly mode: string;
}
export interface RunEndingEvent extends AgentEventBase {
  readonly type: "run.ending";
  readonly reason: string;
}
export interface RunEndedEvent extends AgentEventBase {
  readonly type: "run.ended";
  readonly status: TerminalStatus;
}
export interface StepStartedEvent extends AgentEventBase {
  readonly type: "step.started";
  readonly step: number;
  readonly phase: AgentPhase;
}
export interface StepCompletedEvent extends AgentEventBase {
  readonly type: "step.completed";
  readonly step: number;
  readonly phase: AgentPhase;
}
export interface PhaseChangedEvent extends AgentEventBase {
  readonly type: "phase.changed";
  readonly from: AgentPhase;
  readonly to: AgentPhase;
}
export interface EpochRolledEvent extends AgentEventBase {
  readonly type: "epoch.rolled";
  readonly epoch: number;
}
export interface BackoffEvent extends AgentEventBase {
  readonly type: "backoff";
  readonly ms: number;
  readonly reason: string;
}

// ── Intent ───────────────────────────────────────────────────────────────────
export interface IntentAckEvent extends AgentEventBase {
  readonly type: "intent.ack";
  readonly summary: string;
}

// ── Model I/O ──────────────────────────────────────────────────────────────────
export interface ModelCallStartedEvent extends AgentEventBase {
  readonly type: "model.call.started";
  readonly provider: string;
  readonly model?: string;
  readonly streaming: boolean;
}
/** The token deltas v1's silentStream DISCARDED. channel:"answer" is the only visible one. */
export interface ModelDeltaEvent extends AgentEventBase {
  readonly type: "model.delta";
  readonly channel: ModelDeltaChannel;
  readonly text: string;
}
export interface ModelToolCallEvent extends AgentEventBase {
  readonly type: "model.tool_call";
  readonly toolName: string;
  readonly toolCallId: string;
}
export interface ModelCallFinishedEvent extends AgentEventBase {
  readonly type: "model.call.finished";
  readonly stopReason: StopReason;
  readonly empty: boolean;
  readonly usage?: TokenUsage;
}

// ── Tooling ────────────────────────────────────────────────────────────────────
export interface ToolStartedEvent extends AgentEventBase {
  readonly type: "tool.started";
  readonly toolName: string;
  readonly toolCallId: string;
}
export interface ToolFinishedEvent extends AgentEventBase {
  readonly type: "tool.finished";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly success: boolean;
  readonly errorCategory?: string;
  readonly touchedFiles?: readonly string[];
}

// ── Control ──────────────────────────────────────────────────────────────────
/** v1's TaskProgressSignal verbatim — the existing background narrative survives unchanged. */
export interface NarrativeEvent extends AgentEventBase {
  readonly type: "narrative";
  readonly signal: TaskProgressSignal;
}
/**
 * HEARTBEAT IS A FIRST-CLASS VARIANT — NOT a flag, NOT an empty-content event. This is what
 * lets the watchdog's liveness check and the "is this content?" check never collide. A
 * heartbeat carries NO text by construction.
 */
export interface HeartbeatEvent extends AgentEventBase {
  readonly type: "heartbeat";
  readonly source: "model-keepalive" | "tool-revive" | "loop-yield";
}
export interface AskUserEvent extends AgentEventBase {
  readonly type: "ask_user";
  readonly question: string;
  readonly visibleText: string;
}
export interface ShowPlanEvent extends AgentEventBase {
  readonly type: "show_plan";
  readonly visibleText: string;
}
/** Error is PRE-STRINGIFIED (no Error instance) to keep the union JSON-serializable. */
export interface ErrorEvent extends AgentEventBase {
  readonly type: "error";
  readonly message: string;
  readonly category?: string;
  readonly cancelReason?: CancelReason;
}
/** Mid-task capability bridge-drop narration. */
export interface CapabilityEvent extends AgentEventBase {
  readonly type: "capability";
  readonly message: string;
}

/** THE closed union. Adding a member forces every assertNever switch to update (compile error). */
export type AgentEvent =
  | RunStartedEvent
  | RunEndingEvent
  | RunEndedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | PhaseChangedEvent
  | EpochRolledEvent
  | BackoffEvent
  | IntentAckEvent
  | ModelCallStartedEvent
  | ModelDeltaEvent
  | ModelToolCallEvent
  | ModelCallFinishedEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | NarrativeEvent
  | HeartbeatEvent
  | AskUserEvent
  | ShowPlanEvent
  | ErrorEvent
  | CapabilityEvent;

export type AgentEventType = AgentEvent["type"];

/**
 * Input to emit() — the envelope's bus-stamped fields are omitted (the bus assigns them).
 * A distributive mapped type over each variant's discriminant, so every member's payload is
 * preserved minus the four bus-owned fields.
 */
export type EmittableEvent = {
  [K in AgentEventType]: Omit<Extract<AgentEvent, { type: K }>, "seq" | "ts" | "runId" | "parentRunId">;
}[AgentEventType];

/** Exhaustiveness guard. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled AgentEvent variant: ${JSON.stringify(x)}`);
}

/**
 * The single "is this visible content?" predicate. ONLY model.delta with channel:"answer".
 * heartbeat / reasoning / tool-args / narrative are liveness/observability, never content.
 * This is the structural reason a heartbeat can never be mistaken for a token.
 */
export function isVisibleContent(e: AgentEvent): e is ModelDeltaEvent & { channel: "answer" } {
  return e.type === "model.delta" && e.channel === "answer";
}

/** Liveness-only signal: re-arms the per-task inactivity watchdog, filtered from UI (audit #8). */
const HEARTBEAT_PROGRESS: TaskProgressSignal = { kind: "heartbeat", message: "" };

/**
 * AgentEvent → v1 TaskProgressUpdate — the io-seam adapter the background/worker routes wire in
 * front of their `onProgress` sink (the "open WIRING DECISION" the control-plane ioSink comment
 * deferred; before this, raw AgentEvents were cast into TaskProgressUpdate consumers, so the
 * heartbeat filter (`update.kind === "heartbeat"`) never matched and every bus event leaked
 * toward the UI-facing progress stream as an alien shape).
 *
 * PHASE-0 DUALITY: until the v1 deletion, V1AgentRunner forwards v1's TaskProgressUpdate stream
 * VERBATIM through io.onEvent (a string or a `{kind,…}` signal — see runner/agent-runner.ts's
 * AgentRunEvent note), while the V2 spine emits the closed `{type,…}` union. The adapter accepts
 * both and passes v1 shapes through untouched, so one wiring serves whichever runner is selected.
 *
 * Mapping contract (v1 parity):
 *  - `narrative` carries v1's TaskProgressSignal VERBATIM (by construction) → unwrap it.
 *  - `error` / `capability` surface as visible `status` lines (v1 emitted status on both).
 *  - Everything else (model I/O, tool start/finish ticks, lifecycle, backoff, ask/plan)
 *    collapses to the liveness heartbeat: it re-arms the inactivity watchdog exactly like v1's
 *    silentStream heartbeats and is filtered from the UI. Tool-batch DETAIL is not lost — the
 *    port emits it as a localized `narrative` signal after each tool turn (see
 *    AgentCoreToolTurnResult.progressSignal).
 *
 * KNOWN GAP (deliberate, deferred): v1's background verdict path progressively disclosed
 * degraded/critical provider-health STATUS lines (applyBackgroundVerdict →
 * buildStructuredProgressSignal); collapsing `backoff` to a heartbeat keeps that disclosure
 * absent on the v2 route. The faithful fix belongs at the spine's failure-gate seam (emit a
 * localized `error`/`narrative` event when health degrades), NOT in this shape adapter.
 */
export function agentEventToTaskProgress(e: AgentEvent | TaskProgressUpdate): TaskProgressUpdate {
  // v1 shapes pass through verbatim (V1AgentRunner's Phase-0 stream).
  if (typeof e === "string") return e;
  if (!("type" in e)) return e;
  const event = e as AgentEvent;
  switch (event.type) {
    case "narrative":
      return event.signal;
    case "error":
      return { kind: "status", message: event.message };
    case "capability":
      return { kind: "status", message: event.message };
    case "run.started":
    case "run.ending":
    case "run.ended":
    case "step.started":
    case "step.completed":
    case "phase.changed":
    case "epoch.rolled":
    case "backoff":
    case "intent.ack":
    case "model.call.started":
    case "model.delta":
    case "model.tool_call":
    case "model.call.finished":
    case "tool.started":
    case "tool.finished":
    case "heartbeat":
    case "ask_user":
    case "show_plan":
      return HEARTBEAT_PROGRESS;
    default: {
      // Compile-time exhaustiveness WITHOUT a runtime throw — an io progress adapter must never
      // fail the run on an unknown/foreign event shape; degrade to the liveness heartbeat.
      const _exhaustive: never = event;
      void _exhaustive;
      return HEARTBEAT_PROGRESS;
    }
  }
}
