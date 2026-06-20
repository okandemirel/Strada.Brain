/**
 * Agent Core v2 — the strangler boundary (ARCHITECTURE §4.1–§4.2).
 *
 * `AgentRunner` is the single entry both v1 and v2 implement, so callers are decoupled
 * from which engine runs. `AgentRunResult` is the structured return that KILLS the
 * `__workerCollector` / `__workerMode` cast-through (orchestrator.ts); `WorkerRunResult`
 * becomes a pure projection of it. `IOStrategy` is the one axis of variation between
 * interactive and background — never a forked control flow.
 *
 * Phase 0: only `V1AgentRunner` exists (pass-through over the v1 entry methods). This
 * module is purely additive — net-zero new lines in `orchestrator.ts` (gate §3/B3). It
 * imports ONLY types (no concrete `Orchestrator`/`Session`), so both `src/agent-core/`
 * and `src/tasks/`/`src/agents/` can import it without a cycle (mirrors
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
} from "../../agents/supervisor/supervisor-types.js";
import type { CancelReason } from "../control/cancel-reason.js";
import type { RunClockView } from "../control/run-clock.js";

// ───────────────────────────────────────────────────────────────────────────
// AgentEvent — the one typed stream (ARCHITECTURE §5.1).
//
// Phase 0 scope: V1AgentRunner emits ZERO AgentEvents through onEvent EXCEPT by adapting
// v1's existing TaskProgressUpdate stream (background). The full closed union is owned by
// EventBus and lands in Phase 2; here onEvent's payload is kept deliberately wide (the v1
// narrative shape) so Phase 0 ships without EventBus. We DO NOT invent the union now (that
// is Phase 2 / §5 of ARCHITECTURE); we type the SINK so its contract is stable across the
// swap.
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
   * Deliver the terminal answer. This is the interactive-vs-background divergence made
   * explicit: interactive renders to the channel (v1 `sendVisibleAssistantMarkdown`);
   * background/worker is a NO-OP (the string is carried by `AgentRunResult.finalText`).
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
