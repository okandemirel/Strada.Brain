/**
 * Agent Core v2 — `V1AgentRunner` (ARCHITECTURE §4.1, the Phase-0 strangler adapter).
 *
 * The pass-through implementation of `AgentRunner` over the EXISTING v1 orchestrator entry
 * methods — it adds NO loop logic of its own; it only adapts I/O shapes and projects results.
 * Behavior-preserving by construction: the underlying call is the same `runWorkerTask` v1
 * already runs, plus a pure projection.
 *
 * The central insight: three of the four modes (background, worker, supervisor-node) all
 * bottom out in `runWorkerTask` → `runBackgroundTask`, and `runWorkerTask` already returns a
 * `WorkerRunResult`. So `V1AgentRunner` calls `runWorkerTask` for all three and projects
 * `WorkerRunResult → AgentRunResult`. Only interactive is structurally different (v1's
 * `runAgentLoop` is `void` with channel side-delivery and is `private` + `Session`-driven), so
 * the interactive driver is INJECTED at construction (a closure captured from inside the
 * orchestrator module's already-public surface) — this keeps `orchestrator.ts` at net-zero and
 * `agent-core` free of a concrete `Orchestrator`/`Session` import (no cycle).
 *
 * The `__workerCollector` / `__workerMode` cast-through stays entirely BELOW this seam, inside
 * the untouched v1 `runWorkerTask`/`runBackgroundTask`; nothing here references it. Phase 2
 * deletes the collector by having `V2AgentRunner` return `AgentRunResult` directly.
 */

import type { Attachment } from "../../channels/channel-messages.interface.js";
import type {
  TaskUsageEvent,
  TaskProgressUpdate,
  BackgroundTaskOptions,
} from "../../tasks/types.js";
import type {
  WorkerRunRequest,
  WorkerRunResult,
} from "../../agents/supervisor/supervisor-types.js";
import { AgentPhase, createInitialState } from "../../agents/agent-state.js";
import type { AgentState } from "../../agents/agent-state.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  IOStrategy,
} from "./agent-runner.js";

/**
 * The exact (structural) slice of the v1 `Orchestrator` `V1AgentRunner` depends on. Declared
 * structurally (not by importing the concrete `Orchestrator`) so this file stays in `agent-core`
 * without a cycle; the real `Orchestrator` satisfies it.
 *
 * BOTH entries are optional and the runner does the SAME capability detection the v1
 * `BackgroundExecutor.executeWorkerRun` did: prefer the structured `runWorkerTask`; when it is
 * absent (a legacy orchestrator — exercised by the executor's own test doubles), fall back to the
 * bare-string `runBackgroundTask`. This keeps the reroute strictly behavior-preserving for
 * orchestrators that expose only one of the two methods, instead of assuming `runWorkerTask`
 * always exists. The concrete production `Orchestrator` has both.
 */
export interface V1OrchestratorLike {
  runWorkerTask?(
    request: WorkerRunRequest & {
      signal: AbortSignal;
      onProgress: (message: TaskProgressUpdate) => void;
      attachments?: Attachment[];
      onUsage?: (usage: TaskUsageEvent) => void;
      parentMetricId?: string;
      workspaceLeaseRetained?: boolean;
      supervisorMode?: "auto" | "off";
      goalContext?: { readonly rootId: string; readonly nodeId: string };
    },
  ): Promise<WorkerRunResult>;

  /**
   * Legacy bare-string background entry — the `executeWorkerRun` fallback when `runWorkerTask`
   * is absent. Returns only the visible response string; the runner projects that into a minimal
   * `completed` `AgentRunResult` whose structured fields are empty and which is flagged so
   * `toWorkerRunResult` returns `undefined` (preserving the v1 `{ output, workerResult: undefined }`
   * shape for the legacy path).
   */
  runBackgroundTask?(prompt: string, options: BackgroundTaskOptions): Promise<string>;
}

/**
 * The injected interactive driver — the v1 interactive loop (`runAgentLoop`) reached via a
 * closure captured at wiring time from the orchestrator module's existing public surface. It
 * owns its own channel delivery (v1 `sendVisibleAssistantMarkdown`) and returns `void`. Phase 0
 * supplies it so the `"interactive"` `RunnerMode` is faithful WITHOUT a new orchestrator method.
 * When absent, the interactive mode is unsupported (Phase-0 callers route interactive as
 * background tasks; the live `runAgentLoop` is reached only via the delegation fallback path).
 */
export type InteractiveDriver = (
  request: AgentRunRequest,
  io: IOStrategy,
) => Promise<InteractiveOutcome>;

/**
 * What the injected interactive driver reports back. `runAgentLoop` returns `void` (text is
 * already on the channel), so the driver reports only terminal status (+ optional reason /
 * terminal state) — enough for `V1AgentRunner` to build a minimal `AgentRunResult`. All
 * collector-derived fields are empty because no interactive caller consumes them.
 */
export interface InteractiveOutcome {
  readonly status: AgentRunResult["status"];
  readonly reason?: string;
  readonly terminalState?: AgentState;
}

/**
 * Map the runner-facing `IOStrategy.mode` to the underlying `WorkerRunRequest.mode`, honoring an
 * explicit `request.workerMode` override when present. `"background"` → background; `"worker"`
 * defaults to the request's worker sub-mode (else background); `"supervisor-node"` → delegated.
 */
function resolveWorkerMode(
  request: AgentRunRequest,
  ioMode: IOStrategy["mode"],
): WorkerRunRequest["mode"] {
  if (ioMode === "supervisor-node") return "delegated";
  if (ioMode === "background") return "background";
  // ioMode === "worker": carry the explicit worker sub-mode, defaulting to background.
  return request.workerMode ?? "background";
}

/** Map a terminal `AgentRunResult.status` onto the minimal terminal `AgentPhase`. */
function statusToPhase(status: AgentRunResult["status"]): AgentPhase {
  return status === "completed" ? AgentPhase.COMPLETE : AgentPhase.FAILED;
}

/**
 * The single `WorkerRunResult → AgentRunResult` projection — where `__workerCollector` dies
 * above the seam. Pure; adds no behavior (Phase-0 leaves `usage`/`terminalState`/`cancelReason`
 * unset because v1's worker path surfaces them only via the `onUsage` sink, not the return).
 */
export function projectWorkerResult(worker: WorkerRunResult): AgentRunResult {
  return {
    status: worker.status, // "completed" | "failed" | "blocked" — identical enum
    finalText: worker.visibleResponse,
    finalSummary: worker.finalSummary,
    reason: worker.reason,
    provider: worker.provider,
    model: worker.model,
    catalogVersion: worker.catalogVersion,
    assignmentVersion: worker.assignmentVersion,
    workspaceId: worker.workspaceId,
    touchedFiles: worker.touchedFiles,
    toolTrace: worker.toolTrace,
    verificationResults: worker.verificationResults,
    reviewFindings: worker.reviewFindings,
    artifacts: worker.artifacts,
    usage: undefined, // Phase 0: usage flows via the onUsage sink, not returned
    terminalState: undefined, // Phase 0: worker path doesn't surface AgentState
    cancelReason: undefined, // Phase 0: no typed reason in v1
  };
}

/**
 * Internal marker stamped on an `AgentRunResult` produced from the legacy bare-string
 * `runBackgroundTask` fallback (no structured `WorkerRunResult` underneath). It is a
 * non-enumerable symbol property so it never appears in object spreads, JSON, or
 * `toMatchObject`/`toEqual` comparisons — the public `AgentRunResult` shape is unchanged.
 * `toWorkerRunResult` reads it to decide whether to return `undefined` (the v1 legacy shape).
 */
const LEGACY_BARE_STRING = Symbol("V1AgentRunner.legacyBareString");

/** Stamp the legacy marker on a result without widening its enumerable public shape. */
function markLegacyBareString(result: AgentRunResult): AgentRunResult {
  Object.defineProperty(result, LEGACY_BARE_STRING, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return result;
}

/** True when the result came from the legacy bare-string `runBackgroundTask` path. */
function isLegacyBareString(result: AgentRunResult): boolean {
  return (result as { [LEGACY_BARE_STRING]?: boolean })[LEGACY_BARE_STRING] === true;
}

/**
 * The inverse view: `AgentRunResult → WorkerRunResult | undefined`. Lets callers that still
 * consume `WorkerRunResult` keep their EXACT return shape while the runner speaks the superset
 * internally — including the legacy fallback, where v1 produced NO `workerResult` (so this
 * returns `undefined` for a legacy-flagged result, preserving `{ output, workerResult: undefined }`).
 * For the structured worker path the projection is byte-identical to the v1 worker shape.
 */
export function toWorkerRunResult(result: AgentRunResult): WorkerRunResult | undefined {
  if (isLegacyBareString(result)) {
    return undefined;
  }
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

export class V1AgentRunner implements AgentRunner {
  /**
   * @param orchestrator      The concrete v1 orchestrator (structurally `V1OrchestratorLike`).
   * @param interactiveDriver Optional injected interactive loop closure (see `InteractiveDriver`).
   *                          Required only for the `"interactive"` `RunnerMode`.
   */
  constructor(
    private readonly orchestrator: V1OrchestratorLike,
    private readonly interactiveDriver?: InteractiveDriver,
  ) {}

  run(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult> {
    switch (io.mode) {
      case "interactive":
        return this.runInteractive(request, io);
      case "background":
      case "worker":
      case "supervisor-node":
        return this.runWorker(request, io);
      default: {
        // Exhaustiveness guard — a new RunnerMode must be handled explicitly.
        const never: never = io.mode;
        return Promise.reject(new Error(`Unsupported RunnerMode: ${String(never)}`));
      }
    }
  }

  /**
   * `mode: "interactive"` → the injected v1 interactive driver (`runAgentLoop`). The v1 loop owns
   * its own channel delivery and returns `void`, so `io.onEvent` / `io.visibleSink` /
   * `io.deliverFinal` are inert here (matches v1: intermediate iterations are silent, delivery is
   * internal). The contract still declares them so V2 is a drop-in. `finalText` is `""` because
   * the answer already went to the channel and no interactive caller consumes the return.
   */
  private async runInteractive(
    request: AgentRunRequest,
    io: IOStrategy,
  ): Promise<AgentRunResult> {
    if (!this.interactiveDriver) {
      throw new Error(
        "V1AgentRunner: interactive mode requires an injected interactiveDriver " +
          "(Phase 0 routes interactive user messages as background tasks).",
      );
    }
    let outcome: InteractiveOutcome;
    try {
      outcome = await this.interactiveDriver(request, io);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.buildInteractiveResult({ status: "failed", reason }, request);
    }
    return this.buildInteractiveResult(outcome, request);
  }

  /** Build the minimal `AgentRunResult` for the interactive (void-return) path. */
  private buildInteractiveResult(
    outcome: InteractiveOutcome,
    request: AgentRunRequest,
  ): AgentRunResult {
    const terminalState: AgentState =
      outcome.terminalState ?? {
        ...createInitialState(request.prompt),
        phase: statusToPhase(outcome.status),
      };
    return {
      status: outcome.status,
      finalText: "", // delivered to the channel by the v1 loop; callers ignore the return
      finalSummary: outcome.reason ?? "",
      reason: outcome.reason,
      provider: "unknown",
      model: undefined,
      catalogVersion: "",
      assignmentVersion: 0,
      workspaceId: undefined,
      touchedFiles: [],
      toolTrace: [],
      verificationResults: [],
      reviewFindings: [],
      artifacts: [],
      usage: undefined,
      terminalState,
      cancelReason: undefined,
    };
  }

  /**
   * `mode: "background" | "worker" | "supervisor-node"` → `orchestrator.runWorkerTask(...)`,
   * threading the four I/O divergence axes (onEvent→onProgress, externalSignal→signal) plus the
   * request data, then projecting the `WorkerRunResult` into the `AgentRunResult` superset.
   *
   * `io.visibleSink` is not threaded (background never had a token sink). `io.deliverFinal` is a
   * no-op for these modes (the answer is carried in `finalText`), so it is intentionally NOT
   * invoked — the v1 background path never sends to a channel.
   */
  private async runWorker(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult> {
    const workerMode = resolveWorkerMode(request, io.mode);

    // Capability detection, identical to the v1 BackgroundExecutor.executeWorkerRun: prefer the
    // structured runWorkerTask; fall back to the bare-string runBackgroundTask when absent.
    //
    // `supervisorMode` is forwarded RAW (possibly undefined), exactly as v1's executeWorkerRun did:
    // runWorkerTask (orchestrator.ts:2659) and runBackgroundTask (orchestrator.ts:2738) each own
    // their own default, so pre-resolving it here would diverge from v1 on the legacy path
    // (undefined + non-background mode → v1 runBackgroundTask defaults "auto", a pre-resolved value
    // would force "off"). `parentMetricId` is intentionally NOT threaded — v1's executeWorkerRun
    // passed it on neither path; Phase 2 wires it deliberately (see AgentRunRequest.parentMetricId).
    if (typeof this.orchestrator.runWorkerTask === "function") {
      const worker = await this.orchestrator.runWorkerTask({
        prompt: request.prompt,
        mode: workerMode,
        signal: io.externalSignal, // ← externalSignal axis
        onProgress: io.onEvent, // ← onEvent heartbeat axis (TaskProgressUpdate)
        chatId: request.chatId,
        channelType: request.channelType,
        conversationId: request.conversationId,
        userId: request.userId,
        taskRunId: request.taskRunId,
        assignedProvider: request.assignedProvider,
        assignedModel: request.assignedModel,
        attachments: request.attachments as Attachment[] | undefined,
        userContent: request.userContent,
        onUsage: request.onUsage, // WorkerUsageEvent shape == TaskUsageEvent shape
        workspaceLease: request.workspaceLease,
        workspaceLeaseRetained: request.workspaceLeaseRetained,
        supervisorMode: request.supervisorMode,
        goalContext: request.goalContext,
      });
      return projectWorkerResult(worker);
    }

    if (typeof this.orchestrator.runBackgroundTask === "function") {
      return this.runLegacyBackground(request, io);
    }

    throw new Error(
      "V1AgentRunner: orchestrator exposes neither runWorkerTask nor runBackgroundTask.",
    );
  }

  /**
   * Legacy bare-string fallback (`runBackgroundTask`) — only reached when the orchestrator lacks
   * the structured `runWorkerTask`. Threads the identical I/O axes + request data the v1
   * `executeWorkerRun` legacy branch passed, then builds a minimal `completed` `AgentRunResult`
   * flagged as legacy (so `toWorkerRunResult` returns `undefined`, reproducing v1's
   * `{ output, workerResult: undefined }`). `userContent` here is narrowed to `string |
   * MessageContent[]` to match `BackgroundTaskOptions` (it carries no `null` variant), matching
   * the v1 cast exactly.
   */
  private async runLegacyBackground(
    request: AgentRunRequest,
    io: IOStrategy,
  ): Promise<AgentRunResult> {
    // Mirror v1 executeWorkerRun's legacy literal EXACTLY: runBackgroundTask owns the
    // `supervisorMode ?? "auto"` default (all modes), parentMetricId was never threaded here, and
    // workspaceLeaseRetained was passed through. Any deviation is a latent Phase-2 regression.
    const output = await this.orchestrator.runBackgroundTask!(request.prompt, {
      signal: io.externalSignal,
      onProgress: io.onEvent,
      chatId: request.chatId,
      channelType: String(request.channelType),
      taskRunId: request.taskRunId,
      conversationId: request.conversationId,
      userId: request.userId,
      assignedProvider: request.assignedProvider,
      assignedModel: request.assignedModel,
      attachments: request.attachments as Attachment[] | undefined,
      userContent: request.userContent ?? undefined,
      onUsage: request.onUsage,
      workspaceLease: request.workspaceLease,
      workspaceLeaseRetained: request.workspaceLeaseRetained,
      supervisorMode: request.supervisorMode,
      goalContext: request.goalContext,
    } as BackgroundTaskOptions & { workspaceLeaseRetained?: boolean });
    return markLegacyBareString({
      status: "completed",
      finalText: output,
      finalSummary: output,
      reason: undefined,
      provider: "unknown",
      model: undefined,
      catalogVersion: "",
      assignmentVersion: 0,
      workspaceId: request.workspaceLease?.id,
      touchedFiles: [],
      toolTrace: [],
      verificationResults: [],
      reviewFindings: [],
      artifacts: [],
      usage: undefined,
      terminalState: undefined,
      cancelReason: undefined,
    });
  }
}
