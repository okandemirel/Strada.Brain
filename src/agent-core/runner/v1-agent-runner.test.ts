/**
 * Agent Core v2 — `V1AgentRunner` unit tests (Phase-0 strangler adapter).
 *
 * Asserts the mode→method mapping with a fully mocked orchestrator: the three non-interactive
 * modes route through `runWorkerTask` with the correct `WorkerRunRequest.mode` + threaded I/O
 * axes, the `WorkerRunResult → AgentRunResult` projection is faithful (and round-trips via
 * `toWorkerRunResult`), and the interactive mode delegates to the injected driver / fails closed
 * when none is supplied. No real orchestrator, no network — pure adapter behavior.
 */

import { describe, it, expect, vi } from "vitest";
import {
  V1AgentRunner,
  projectWorkerResult,
  toWorkerRunResult,
  type V1OrchestratorLike,
  type InteractiveDriver,
} from "./v1-agent-runner.js";
import type { AgentRunRequest, IOStrategy } from "./agent-runner.js";
import type {
  WorkerRunResult,
  WorkerRunRequest,
} from "../../agents/supervisor/supervisor-types.js";
import { AgentPhase } from "../../agents/agent-state.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A representative populated `WorkerRunResult` exercising every projected field. */
function workerResult(overrides: Partial<WorkerRunResult> = {}): WorkerRunResult {
  return {
    status: "completed",
    finalSummary: "did the thing",
    visibleResponse: "Here is the answer.",
    provider: "anthropic",
    model: "claude-opus-4-8",
    catalogVersion: "anthropic:claude-opus-4-8:123:fresh:healthy",
    assignmentVersion: 7,
    workspaceId: "ws_42",
    touchedFiles: ["src/a.ts", "src/b.ts"],
    toolTrace: [{ toolName: "edit_file", success: true, summary: "edited a.ts", timestamp: 1 }],
    verificationResults: [{ name: "typecheck", status: "clean", summary: "no errors" }],
    reviewFindings: [{ source: "code-review", severity: "info", message: "looks good" }],
    artifacts: [{ kind: "result", summary: "patch ready" }],
    reason: undefined,
    ...overrides,
  };
}

/** Mock orchestrator that records the `runWorkerTask` request and returns a canned result. */
function mockOrchestrator(result: WorkerRunResult = workerResult()): {
  orchestrator: V1OrchestratorLike;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(result);
  return { orchestrator: { runWorkerTask: spy }, spy };
}

function baseRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    prompt: "do a task",
    chatId: "chat-1",
    channelType: "web",
    ...overrides,
  };
}

function baseIo(overrides: Partial<IOStrategy> = {}): IOStrategy {
  return {
    mode: "background",
    onEvent: () => {},
    deliverFinal: () => {},
    externalSignal: new AbortController().signal,
    ...overrides,
  } as IOStrategy;
}

// ── mode → method mapping ─────────────────────────────────────────────────────

describe("V1AgentRunner mode→method mapping", () => {
  it("routes mode:'background' to runWorkerTask with WorkerRunRequest.mode='background'", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    await runner.run(baseRequest(), baseIo({ mode: "background" }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ mode: "background" });
  });

  it("routes mode:'supervisor-node' to runWorkerTask with WorkerRunRequest.mode='delegated'", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    await runner.run(baseRequest(), baseIo({ mode: "supervisor-node" }));

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ mode: "delegated" });
  });

  it("routes mode:'worker' to runWorkerTask, defaulting WorkerRunRequest.mode to 'background'", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    await runner.run(baseRequest(), baseIo({ mode: "worker" }));

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ mode: "background" });
  });

  it("routes mode:'worker' honoring an explicit request.workerMode override", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    await runner.run(
      baseRequest({ workerMode: "delegated" }),
      baseIo({ mode: "worker" }),
    );

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ mode: "delegated" });
  });
});

// ── I/O axis threading ─────────────────────────────────────────────────────────

describe("V1AgentRunner I/O axis threading", () => {
  it("threads externalSignal→signal and onEvent→onProgress verbatim", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    const signal = new AbortController().signal;
    const onEvent = vi.fn();

    await runner.run(baseRequest(), baseIo({ externalSignal: signal, onEvent }));

    const call = spy.mock.calls[0]?.[0] as { signal: AbortSignal; onProgress: unknown };
    expect(call.signal).toBe(signal);
    // onProgress must be the SAME function reference (no wrapping) so the heartbeat sink is verbatim.
    expect(call.onProgress).toBe(onEvent);
  });

  it("threads request data (identity, attachments, lease, onUsage, goalContext)", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    const onUsage = vi.fn();
    const lease = { id: "lease-9" } as unknown as AgentRunRequest["workspaceLease"];

    await runner.run(
      baseRequest({
        conversationId: "conv-1",
        userId: "user-1",
        taskRunId: "run-1",
        assignedProvider: "openai",
        assignedModel: "gpt-x",
        workspaceLease: lease,
        workspaceLeaseRetained: true,
        goalContext: { rootId: "root", nodeId: "node" },
        onUsage,
      }),
      baseIo({ mode: "worker" }),
    );

    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      prompt: "do a task",
      chatId: "chat-1",
      channelType: "web",
      conversationId: "conv-1",
      userId: "user-1",
      taskRunId: "run-1",
      assignedProvider: "openai",
      assignedModel: "gpt-x",
      workspaceLease: lease,
      workspaceLeaseRetained: true,
      goalContext: { rootId: "root", nodeId: "node" },
      onUsage,
    });
  });

  it("forwards monitorScope onto runWorkerTask so the parent-episode rollup reaches runBackgroundTask's consumer", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    // A worker fanned out from a parent goal carries the parent's monitorScope; the runner must
    // forward it verbatim onto the runWorkerTask request (the field is consumed downstream in
    // Orchestrator.runBackgroundTask, which joinEpisode's the worker's card onto the parent episode
    // when the worker runs under a DISTINCT scope). MONITOR-only: identity is untouched.
    await runner.run(
      baseRequest({ chatId: "chat-1", monitorScope: "parent-goal-scope" }),
      baseIo({ mode: "supervisor-node" }),
    );

    const call = spy.mock.calls[0]?.[0] as { monitorScope?: string; chatId: string };
    expect(call.monitorScope).toBe("parent-goal-scope");
    // MONITOR-only: the worker's own identity (chatId) is forwarded UNCHANGED.
    expect(call.chatId).toBe("chat-1");
  });

  it("forwards monitorScope as undefined when the run is its own whole-goal root (byte-identical to prior)", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    await runner.run(baseRequest(), baseIo({ mode: "background" }));
    expect((spy.mock.calls[0]?.[0] as { monitorScope?: string }).monitorScope).toBeUndefined();
  });

  it("forwards supervisorMode RAW — the orchestrator owns the per-mode default (v1 parity)", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    // Unset supervisorMode is forwarded as undefined, NOT pre-resolved at the seam; runWorkerTask /
    // runBackgroundTask apply their own per-mode default exactly as v1 executeWorkerRun did.
    await runner.run(baseRequest(), baseIo({ mode: "background" }));
    expect((spy.mock.calls[0]?.[0] as { supervisorMode?: string }).supervisorMode).toBeUndefined();

    spy.mockClear();
    await runner.run(baseRequest(), baseIo({ mode: "supervisor-node" }));
    expect((spy.mock.calls[0]?.[0] as { supervisorMode?: string }).supervisorMode).toBeUndefined();
  });

  it("honors an explicit request.supervisorMode over the per-mode default", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    await runner.run(baseRequest({ supervisorMode: "off" }), baseIo({ mode: "background" }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ supervisorMode: "off" });
  });

  it("does NOT invoke deliverFinal for the background/worker path (string carried in result)", async () => {
    const { orchestrator } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);
    const deliverFinal = vi.fn();

    await runner.run(baseRequest(), baseIo({ mode: "background", deliverFinal }));
    expect(deliverFinal).not.toHaveBeenCalled();
  });
});

// ── v1 options parity (review regression) ────────────────────────────────────────
//
// The Phase-0 adversarial review found V1AgentRunner's options literal diverged from the v1
// BackgroundExecutor.executeWorkerRun it replaces: supervisorMode was pre-resolved (forcing "off"
// on the legacy non-background path where v1 defaults "auto"), parentMetricId was newly threaded
// (v1 threaded it on neither path), and workspaceLeaseRetained was dropped from the legacy literal.
// These pin the literal to an EXACT v1 mirror so Phase 2 cannot silently inherit the divergence.

describe("V1AgentRunner v1 options parity (review regression)", () => {
  it("structured path mirrors executeWorkerRun: raw supervisorMode, no parentMetricId, keeps workspaceLeaseRetained", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    await runner.run(
      baseRequest({ parentMetricId: "m-1", workspaceLeaseRetained: true }),
      baseIo({ mode: "supervisor-node" }), // non-background: the divergence-prone case
    );

    const opts = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.supervisorMode).toBeUndefined(); // raw, NOT pre-resolved "off"
    expect("parentMetricId" in opts).toBe(false); // v1 never threaded it
    expect(opts.workspaceLeaseRetained).toBe(true);
  });

  it("legacy bare-string path mirrors executeWorkerRun and returns a worker-less completed result", async () => {
    const bgSpy = vi.fn().mockResolvedValue("legacy answer");
    const runner = new V1AgentRunner({ runBackgroundTask: bgSpy } as unknown as V1OrchestratorLike);

    const result = await runner.run(
      baseRequest({ parentMetricId: "m-1", workspaceLeaseRetained: true, userContent: null }),
      baseIo({ mode: "supervisor-node" }), // non-background + unset supervisorMode = the exact divergence case
    );

    const opts = bgSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    // Pre-resolving here forced "off"; v1 forwards undefined so runBackgroundTask's own `?? "auto"` runs.
    expect(opts.supervisorMode).toBeUndefined();
    expect("parentMetricId" in opts).toBe(false);
    expect(opts.workspaceLeaseRetained).toBe(true);
    // userContent forwarded RAW — null preserved, NOT coerced to undefined (exact v1 mirror).
    expect(opts.userContent).toBeNull();
    // Legacy bare string → completed result carrying the text; no structured WorkerRunResult.
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("legacy answer");
    expect(toWorkerRunResult(result)).toBeUndefined();
  });
});

// ── WorkerRunResult → AgentRunResult projection ──────────────────────────────────

describe("V1AgentRunner result projection", () => {
  it("projects every WorkerRunResult field onto AgentRunResult", async () => {
    const worker = workerResult();
    const { orchestrator } = mockOrchestrator(worker);
    const runner = new V1AgentRunner(orchestrator);

    const result = await runner.run(baseRequest(), baseIo({ mode: "background" }));

    expect(result).toMatchObject({
      status: "completed",
      finalText: worker.visibleResponse,
      finalSummary: worker.finalSummary,
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
    });
    // Phase-0 deferred fields are explicitly absent.
    expect(result.usage).toBeUndefined();
    expect(result.terminalState).toBeUndefined();
    expect(result.cancelReason).toBeUndefined();
  });

  it("preserves a failed status + reason through the projection", async () => {
    const worker = workerResult({ status: "failed", reason: "provider exploded", visibleResponse: "" });
    const { orchestrator } = mockOrchestrator(worker);
    const runner = new V1AgentRunner(orchestrator);

    const result = await runner.run(baseRequest(), baseIo({ mode: "worker" }));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("provider exploded");
  });

  it("projectWorkerResult ∘ toWorkerRunResult round-trips the worker shape", () => {
    const worker = workerResult();
    const roundTripped = toWorkerRunResult(projectWorkerResult(worker));
    expect(roundTripped).toEqual(worker);
  });
});

// ── interactive mode ─────────────────────────────────────────────────────────────

describe("V1AgentRunner interactive mode", () => {
  it("delegates to the injected interactiveDriver and builds a minimal result", async () => {
    const { orchestrator, spy } = mockOrchestrator();
    const driver: InteractiveDriver = vi.fn().mockResolvedValue({ status: "completed" });
    const runner = new V1AgentRunner(orchestrator, driver);

    const result = await runner.run(baseRequest(), baseIo({ mode: "interactive" }));

    expect(driver).toHaveBeenCalledTimes(1);
    // Interactive never touches runWorkerTask.
    expect(spy).not.toHaveBeenCalled();
    // finalText empty (delivered via channel), terminal phase reconstructed from status.
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("");
    expect(result.terminalState?.phase).toBe(AgentPhase.COMPLETE);
  });

  it("reconstructs a FAILED terminal phase when the driver reports failure", async () => {
    const { orchestrator } = mockOrchestrator();
    const driver: InteractiveDriver = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "blocked by user" });
    const runner = new V1AgentRunner(orchestrator, driver);

    const result = await runner.run(baseRequest(), baseIo({ mode: "interactive" }));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("blocked by user");
    expect(result.terminalState?.phase).toBe(AgentPhase.FAILED);
  });

  it("maps a thrown interactive driver to a failed result (does not reject)", async () => {
    const { orchestrator } = mockOrchestrator();
    const driver: InteractiveDriver = vi.fn().mockRejectedValue(new Error("loop crashed"));
    const runner = new V1AgentRunner(orchestrator, driver);

    const result = await runner.run(baseRequest(), baseIo({ mode: "interactive" }));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("loop crashed");
  });

  it("throws when interactive mode is used without an injected driver", async () => {
    const { orchestrator } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    await expect(runner.run(baseRequest(), baseIo({ mode: "interactive" }))).rejects.toThrow(
      /interactive mode requires an injected interactiveDriver/,
    );
  });

  it("uses the driver-supplied terminalState verbatim when provided", async () => {
    const { orchestrator } = mockOrchestrator();
    const customState = { phase: AgentPhase.COMPLETE, iteration: 5 } as unknown as NonNullable<
      Awaited<ReturnType<InteractiveDriver>>["terminalState"]
    >;
    const driver: InteractiveDriver = vi
      .fn()
      .mockResolvedValue({ status: "completed", terminalState: customState });
    const runner = new V1AgentRunner(orchestrator, driver);

    const result = await runner.run(baseRequest(), baseIo({ mode: "interactive" }));
    expect(result.terminalState).toBe(customState);
  });
});

// ── WorkerRunRequest.mode is a valid value (type-level sanity at runtime) ──────────

describe("V1AgentRunner WorkerRunRequest.mode validity", () => {
  it("only ever emits a legal WorkerRunRequest.mode value", async () => {
    const legal: ReadonlySet<WorkerRunRequest["mode"]> = new Set([
      "interactive",
      "background",
      "delegated",
    ]);
    const { orchestrator, spy } = mockOrchestrator();
    const runner = new V1AgentRunner(orchestrator);

    for (const mode of ["background", "worker", "supervisor-node"] as const) {
      spy.mockClear();
      await runner.run(baseRequest(), baseIo({ mode }));
      const emitted = (spy.mock.calls[0]?.[0] as { mode: WorkerRunRequest["mode"] }).mode;
      expect(legal.has(emitted)).toBe(true);
    }
  });
});
