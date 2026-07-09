/**
 * Agent Core v2 — the strangler boundary (ARCHITECTURE §4.1–§4.2).
 *
 * `AgentRunner` is the single entry both v1 and v2 implement, so callers are decoupled
 * from which engine runs. `AgentRunResult` is the structured return that KILLS the
 * `__workerCollector` / `__workerMode` cast-through (orchestrator.ts); `WorkerRunResult`
 * becomes a pure projection of it. `IOStrategy` is the one axis of variation between
 * interactive and background — never a forked control flow.
 *
 * Since cutover Step 5 the `V2AgentRunner` spine is THE engine (the v1 pass-through was
 * deleted). This module imports ONLY types (no concrete `Orchestrator`/`Session`), so both
 * `src/agent-core/` and `src/tasks/`/`src/agents/` can import it without a cycle (mirrors
 * `orchestrator-contract.ts`).
 */

import type { Attachment, ChannelType } from "../../channels/channel-messages.interface.js";
import type { MessageContent, TokenUsage } from "../../agents/providers/provider-core.interface.js";
import type { AgentState } from "../../agents/agent-state.js";
import type { TaskProgressUpdate } from "../../tasks/types.js";
import type { WorkspaceLease } from "../../agents/supervisor/supervisor-types.js";
import type {
  WorkerToolTrace,
  WorkerVerificationResult,
  WorkerReviewFinding,
  WorkerArtifactMetadata,
  WorkerUsageEvent,
  WorkerRunResult,
} from "../../agents/supervisor/supervisor-types.js";
import type { CancelReason } from "../control/cancel-reason.js";
import type { RunClockView } from "../control/run-clock.js";

// ───────────────────────────────────────────────────────────────────────────
// AgentEvent — the one typed stream (ARCHITECTURE §5.1).
//
// The SINK's payload type is deliberately the v1 TaskProgressUpdate shape: the closed
// AgentEvent union rides through it via the control-plane ioSink cast, and consumers adapt
// with agentEventToTaskProgress (events/agent-event.ts). Retyping the sink to the closed
// union belongs to the engine-relocation step.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Phase-0 event payload = v1's `TaskProgressUpdate` verbatim (`string | TaskProgressSignal`).
 * In Phase 2 this widens to the closed `AgentEvent` union; the SINK signature
 * (`onEvent: (e) => void`) is frozen now so callers never change. `heartbeat`-kind signals
 * already exist in v1's `TaskProgressKind` and carry the liveness contract.
 */
export type AgentRunEvent = TaskProgressUpdate;

/** A non-empty visible token chunk (ARCHITECTURE §4.2). Empty/keepalive never reaches here. */
export interface VisibleChunk {
  /** Non-empty assistant-answer text. Channel: "answer" only — reasoning/keepalive stay on onEvent. */
  readonly text: string;
}

/**
 * The four caller shapes. NOTE: `"worker"` is the structured-result background variant
 * (mode in `WorkerRunRequest` is `"interactive" | "background" | "delegated"`);
 * `"supervisor-node"` is the delegated node-bridge. This enum is the IOStrategy/runner-facing
 * mode and maps onto `RunMode` (control/policy.ts:
 * `"interactive" | "background" | "supervisor-node" | "delegate"`) 1:1 — same four names
 * modulo `"delegate"` ≡ `"supervisor-node"` / `"worker-delegated"`.
 */
export type RunnerMode = "interactive" | "background" | "worker" | "supervisor-node";

// ───────────────────────────────────────────────────────────────────────────
// IOStrategy — the one axis of variation (ARCHITECTURE §4.2).
//
// Exactly the four divergences the maps found, no control-flow knobs (iteration limits /
// timeouts live in the Control Plane, NOT here):
//   onEvent        — the heartbeat + narrative sink (bg onProgress; interactive: silent today)
//   visibleSink    — OPTIONAL token sink (interactive channel render; bg/worker: undefined)
//   deliverFinal   — the terminal-text delivery divergence (interactive sendMarkdown; bg no-op)
//   externalSignal — control-plane cancel (= task token); bg/worker mandatory, interactive synth
// ───────────────────────────────────────────────────────────────────────────

export interface IOStrategy {
  /** Which driver shape. Selects the v1 method in `V1AgentRunner`; selects policy mode in V2. */
  readonly mode: RunnerMode;

  /**
   * EVERY observable event (the heartbeat sink). The watchdog observes the same stream the
   * UI observes. Background maps this to its `onProgress` callback verbatim; interactive's
   * v1 path emits nothing here today (`V1AgentRunner` supplies a no-op), so the seam is
   * captured without changing interactive behavior.
   */
  onEvent(e: AgentRunEvent): void;

  /**
   * OPTIONAL token sink. Present only when the channel renders live tokens. In Phase 0 it is
   * ALWAYS undefined (v1 streams silently — `silentStream` discards text; nothing is wired to
   * a visible streaming message). Capturing it now keeps the field stable for Phase 5
   * (`streamVisibleTokens`). `visibleSink` receives ONLY non-empty answer text.
   */
  visibleSink?: (chunk: VisibleChunk) => void;

  /**
   * Deliver the terminal answer. The divergence is by RUNNER, not by mode alone:
   *  - `V1AgentRunner` interactive RENDERS here (v1 `sendVisibleAssistantMarkdown`).
   *  - `V2AgentRunner` interactive is a NO-OP: the faithful port's dispatch handlers
   *    (`portDispatchEndTurn`/`portDispatchReflection` → `emitVisibleBoundary` →
   *    `sendVisibleAssistantMarkdown`) ALREADY render the answer to the channel DURING the run,
   *    and `synthesizeFinal` only reads it back into `AgentRunResult.finalText`; rendering here
   *    too would DOUBLE-RENDER.
   *  - background/worker (both runners) is a NO-OP (the string is carried by `finalText`).
   * `state` is the terminal `AgentState` (phase/iteration) for sinks that annotate.
   */
  deliverFinal(text: string, state: AgentState): void;

  /**
   * Control-plane cancel (= the task token's signal). Background/worker pass their mandatory
   * `options.signal`; interactive has NO external signal in v1 (documented in orchestrator.ts)
   * so `V1AgentRunner` synthesizes a never-aborting signal here. In Phase 1+ this is the
   * `RunClock` task token; the field shape does not change.
   */
  readonly externalSignal: AbortSignal;
}

// ───────────────────────────────────────────────────────────────────────────
// AgentRunRequest — the union of every input the four v1 entries accept.
// Superset of: runAgentLoop(chatId, session, channelType?, userId?, conversationId?, attachments?)
//            + BackgroundTaskOptions (minus the I/O callbacks, which moved to IOStrategy)
//            + WorkerRunRequest envelope.
// I/O callbacks (signal/onProgress/onUsage) are NOT here — they live on IOStrategy + the
// onUsage sink — so the request is pure data (serializable, replayable for P-E).
// ───────────────────────────────────────────────────────────────────────────

export interface AgentRunRequest {
  /**
   * The task text. (`runAgentLoop` derives this from the session's last user turn; the
   * background/worker path passes it explicitly. `V1AgentRunner` handles both.)
   */
  readonly prompt: string;

  /** Conversation identity (all four entries take these). */
  readonly chatId: string;
  readonly channelType: ChannelType | string;
  readonly conversationId?: string;
  readonly userId?: string;

  /** Per-run id for metrics/workspace correlation (`BackgroundTaskOptions.taskRunId`). */
  readonly taskRunId?: string;

  /** Multimodal inputs (all four entries). */
  readonly attachments?: readonly Attachment[];
  readonly userContent?: string | MessageContent[] | null;

  /** Fixed provider/model assignment for delegated / supervisor-node child runs. */
  readonly assignedProvider?: string;
  readonly assignedModel?: string;

  /**
   * Subtask metric parent (`BackgroundTaskOptions.parentMetricId`). Accepted by the contract but
   * NOT threaded by V1AgentRunner in Phase 0 — v1's executeWorkerRun forwarded it on neither the
   * structured nor the legacy path; Phase 2 wires it deliberately. Setting it now is a no-op.
   */
  readonly parentMetricId?: string;

  /** Isolated workspace for parallel worker execution (`BackgroundTaskOptions.workspaceLease`). */
  readonly workspaceLease?: WorkspaceLease;
  /** Whether the caller retains the lease (worker artifact metadata). */
  readonly workspaceLeaseRetained?: boolean;

  /** Nested-supervision toggle (`BackgroundTaskOptions.supervisorMode`). Default per-mode. */
  readonly supervisorMode?: "auto" | "off";

  /** Goal-tree substep context (`BackgroundTaskOptions.goalContext`). */
  readonly goalContext?: { readonly rootId: string; readonly nodeId: string };

  /**
   * Whole-goal MONITOR scope (optional). When a single user request fans out into
   * supervisor-decomposed worker runs (each with its own chatId/session/identity), the
   * originating request's `resolveConversationScope` is stamped here so each worker's
   * monitor events JOIN the parent goal's episode (one dropdown conversation per whole
   * goal) instead of minting a sibling episode. MONITOR-only: `V1AgentRunner` forwards it
   * onto the worker's `IncomingMessage`/`Task` for the monitor consumer; it NEVER re-keys
   * the worker's chatId/conversationId/session/identity (those stay fresh by design).
   * Absent ⇒ the run is its own whole-goal root (byte-identical to the prior behavior).
   */
  readonly monitorScope?: string;

  /**
   * Worker driver sub-mode, carried only for the `"worker"`/`"supervisor-node"` RunnerModes —
   * the underlying `WorkerRunRequest.mode` (`"interactive" | "background" | "delegated"`). When
   * omitted, `V1AgentRunner` derives it from `IOStrategy.mode`.
   */
  readonly workerMode?: "interactive" | "background" | "delegated";

  /**
   * Usage sink (`BackgroundTaskOptions.onUsage` / `WorkerExecutionEnvelope.onUsage`). Kept on
   * the REQUEST (not `IOStrategy`) because it is per-run accounting, not an I/O-shape concern,
   * and both background and worker pass it identically. Optional; interactive omits it (v1 does).
   */
  readonly onUsage?: (usage: WorkerUsageEvent) => void;

  /**
   * Pre-existing interactive session handle. `runAgentLoop` is driven by a live `Session`
   * object, not a bare prompt; `V1AgentRunner`'s interactive branch needs it to call the
   * existing method. Opaque here (typed `unknown`) to avoid importing the orchestrator's
   * `Session` type into `agent-core` (no cycle); the `V1AgentRunner` casts it back. For
   * background/worker this is undefined (those build their own session internally).
   */
  readonly interactiveSession?: unknown;

  /**
   * Phase 1+ only: parent `RunClock` view for delegated/supervisor-node runs (shared clock,
   * read-only — ARCHITECTURE §1.1). Undefined in Phase 0 (no control plane in the loop yet).
   * Present in the contract now so the field is stable when Phase 1 threads it.
   */
  readonly parentClockView?: RunClockView;
}

// ───────────────────────────────────────────────────────────────────────────
// AgentRunResult — the structured return that KILLS __workerCollector (ARCHITECTURE §4.1).
// Superset of WorkerRunResult; WorkerRunResult becomes a pure projection.
// Every field the collector smuggled out is a first-class return field here.
// ───────────────────────────────────────────────────────────────────────────

export type TerminalStatus = "completed" | "failed" | "blocked";

export interface AgentRunResult {
  /**
   * Normalized terminal status. interactive: completed unless catch→failed/blocked;
   * background: completed unless thrown→failed; worker: `WorkerRunResult.status` verbatim.
   */
  readonly status: TerminalStatus;

  /** The visible answer text (== v1 `finalVisibleResponse` / the returned string). */
  readonly finalText: string;

  /** Short summary (`collector.finalSummary`; falls back to `finalText || reason`). */
  readonly finalSummary: string;

  /** Why it failed/blocked, if it did (`collector.reason` / `thrownReason`). */
  readonly reason?: string;

  /** Final provider assignment (`collector.lastAssignment.providerName`; "unknown" if none). */
  readonly provider: string;
  readonly model?: string;
  readonly catalogVersion: string;
  readonly assignmentVersion: number;

  /** Workspace + file effects (`collector.touchedFiles` ∪ child touched files). */
  readonly workspaceId?: string;
  readonly touchedFiles: readonly string[];

  /** Executed tool sequence (`collector.toolTrace`) — the P-E tool-sequence oracle. */
  readonly toolTrace: readonly WorkerToolTrace[];

  /** Verification + review (projected from `collector.verifierResult`). */
  readonly verificationResults: readonly WorkerVerificationResult[];
  readonly reviewFindings: readonly WorkerReviewFinding[];

  /** Result artifacts (workspace/patch/result metadata). */
  readonly artifacts: readonly WorkerArtifactMetadata[];

  /** Measured token/cost usage for this run (Phase 1+ from Budget; Phase 0 best-effort/empty). */
  readonly usage?: TokenUsage;

  /**
   * The terminal `AgentState` (phase, iteration, reflection counts). Carried so the P-E
   * equivalence relation can read the terminal phase, and so `deliverFinal`'s `state` arg is
   * sourced from one place. Optional because the interactive v1 path returns void and does not
   * currently surface its terminal state — `V1AgentRunner` reconstructs a minimal one
   * (status→phase) for that mode.
   */
  readonly terminalState?: AgentState;

  /**
   * The typed cancel reason if the run ended via cancellation (Phase 1+; from `CancelToken`).
   * Phase 0: undefined (v1 has no typed reason). Field present so the shape is stable.
   */
  readonly cancelReason?: CancelReason;
}

// ───────────────────────────────────────────────────────────────────────────
// AgentRunner — the façade (ARCHITECTURE §4.1). One method, both engines implement it.
// ───────────────────────────────────────────────────────────────────────────

export interface AgentRunner {
  run(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult>;
}

/**
 * The inverse view: `AgentRunResult → WorkerRunResult` — a TOTAL projection. Lets callers that
 * still consume `WorkerRunResult` (background-executor, delegation-manager) keep their EXACT
 * return shape while the runner speaks the superset internally. Relocated from the deleted
 * V1AgentRunner module (cutover Step 5) minus its legacy bare-string branch (producer deleted).
 */
export function toWorkerRunResult(result: AgentRunResult): WorkerRunResult {
  return {
    status: result.status,
    finalSummary: result.finalSummary,
    visibleResponse: result.finalText,
    provider: result.provider,
    model: result.model,
    catalogVersion: result.catalogVersion,
    assignmentVersion: result.assignmentVersion,
    workspaceId: result.workspaceId,
    touchedFiles: result.touchedFiles,
    toolTrace: result.toolTrace,
    verificationResults: result.verificationResults,
    reviewFindings: result.reviewFindings,
    artifacts: result.artifacts,
    reason: result.reason,
  };
}
