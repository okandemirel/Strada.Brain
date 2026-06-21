/**
 * Agent Core v2 — Control Plane assembler (ARCHITECTURE §2–§3, §5.1).
 *
 * The concrete {@link ControlPlane} the V2AgentRunner reads the four foundations through. Bundles
 * openRunClock + createBudget + createFailureLedger (control/*) behind ControlPlane.openRun, and
 * wraps io's onEvent sink + the learning bridge as run-scoped BoundedSinks behind
 * ControlPlane.openBus. PURELY ADDITIVE — new file, nothing in v1 routes here yet.
 *
 * openRun takes only (mode, parentClockView?) per the FROZEN ControlPlane interface
 * (v2-agent-runner.ts:78-81), so the clock / seed / health are captured HERE at construction and
 * the policy is resolved per call. resolveRunBudgetPolicy is pure+deterministic on (mode, seed),
 * so the policy backing these primitives === the one the spine already logged in its prologue.
 *
 * Import direction is safe: this file imports ControlPlane / OpenRunResult / IOStrategy as
 * `import type` only (erased at compile time), so the existing control → runner value imports in
 * v2-agent-runner.ts (resolveRunBudgetPolicy, describeCancelReason, mapVerdictToLoopAction) do NOT
 * close a cycle.
 */

import type { Clock } from "./clock.js";
import { openRunClock } from "./run-clock.js";
import type { RunClockView } from "./run-clock.js";
import { createBudget } from "./budget.js";
import { createFailureLedger, type HealthCore } from "./failure-ledger.js";
import { resolveRunBudgetPolicy, type PolicySeed, type RunMode } from "./policy.js";

import type { ControlPlane, OpenRunResult } from "../runner/v2-agent-runner.js";
import type { IOStrategy } from "../runner/agent-runner.js";
import {
  createAgentRunEventBus,
  type AgentRunEventBus,
  type LiveSink,
} from "../events/event-bus.js";
import { createBoundedSink } from "../events/bounded-sink.js";
import { createLearningBridgeSink } from "../events/learning-bridge.js";
import type { IEventEmitter } from "../../core/event-bus.js";
import type { AgentEvent } from "../events/agent-event.js";

/**
 * Everything the assembler captures once per RUNNER (not per run).
 *
 * The HealthCore is provided as a FACTORY, not an instance: FailureLedgerImpl holds one `core`
 * + `pauseRetryUsed` PER RUN (failure-ledger.ts:70-76, "One instance per run"), so every
 * openRun() must mint a fresh core or failure history leaks across runs. A caller that genuinely
 * wants single-run semantics passes `() => theCore`.
 */
export interface ControlPlaneDeps {
  /**
   * Injected time source — SystemClock in prod, FakeClock in P-E tests. The SAME clock the
   * RunClock timers AND the EventBus ts-stamp read, so deadlines + event order stay coherent.
   */
  readonly clock: Clock;

  /** The v1 config defaults threaded in by the caller (no direct config import in control/). */
  readonly seed: PolicySeed;

  /**
   * Mint a fresh HealthCore per run (one IterationHealthCoreAdapter per task). Called INSIDE
   * openRun so failure accounting never leaks across runs.
   */
  readonly createHealthCore: () => HealthCore;

  /**
   * Optional process-wide learning emitter; when present openBus attaches the learning-bridge
   * sink (tool.finished → "tool:result"). Omitted ⇒ no bridge (interactive / test).
   */
  readonly learning?: IEventEmitter;

  /** Ring capacity override forwarded to the bus (bus default is 2048). */
  readonly ringCapacity?: number;
}

/**
 * Build the concrete ControlPlane. Mirrors the factory style of createBudget /
 * createFailureLedger / openRunClock / createAgentRunEventBus.
 */
export function createControlPlane(deps: ControlPlaneDeps): ControlPlane {
  const { clock, seed, createHealthCore, learning, ringCapacity } = deps;

  return {
    openRun(mode: RunMode, _parentClockView?: RunClockView): OpenRunResult {
      // Policy is resolved per run from the captured seed. Warnings are the SPINE's to log (it
      // already calls resolveRunBudgetPolicy in its prologue for callLimits + warning logging);
      // both calls are pure + deterministic on the same (mode, seed), so the policy the spine
      // logged === the policy backing these primitives. Re-surfacing warnings here would just
      // double-log, so they are intentionally dropped on this path.
      const { policy } = resolveRunBudgetPolicy(mode, seed);
      const health = createHealthCore();
      return {
        clock: openRunClock(clock, policy),
        ledger: createFailureLedger(health, { pauseRetryBudget: policy.pauseRetryBudget }),
        budget: createBudget(policy.outputTokenCap, policy.costCapUsd),
      };
      // parentClockView: a delegated child shares the PARENT's wall-clock ceiling
      // (min(child.taskHardMs, parent.remainingTaskMs)). openRunClock has no "open under a parent
      // view" constructor yet, so that shared-clock wiring is deferred to the worker-route-flip
      // increment — the same deferral the spine header documents. Accepted + ignored for now.
    },

    openBus(runId: string, io: IOStrategy, parentRunId?: string): AgentRunEventBus {
      const bus = createAgentRunEventBus({ runId, parentRunId, clock, ringCapacity });

      // io.onEvent is the heartbeat/narrative axis. It expects v1's AgentRunEvent
      // (TaskProgressUpdate) shape, NOT the closed AgentEvent union — the AgentEvent →
      // TaskProgressUpdate adapter is the open WIRING DECISION (runner header Part 3, item).
      // Until that lands the `as unknown as` localizes the seam to ONE line. Wrapped as a
      // BoundedSink so a slow channel never blocks emit() (model.delta coalesces lossy-newest).
      const ioSink: LiveSink = createBoundedSink({
        id: "io",
        flush: (batch: readonly AgentEvent[]) => {
          for (const e of batch) {
            io.onEvent(e as unknown as Parameters<IOStrategy["onEvent"]>[0]);
          }
        },
      });
      bus.addSink(ioSink);

      // Bridge tool.finished → the process-wide learning pipeline, only when wired.
      if (learning) bus.addSink(createLearningBridgeSink(runId, learning));

      return bus;
    },
  };
}
