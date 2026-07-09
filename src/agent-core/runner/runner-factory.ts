/**
 * Agent Core v2 — the per-route runner selector (Phase 2 route flip).
 *
 * `selectAgentRunner` is the single decision point that picks V2AgentRunner vs the v1 pass-through
 * for a given route, reading the resolved agent-core flag set off the orchestrator. It is the slot
 * `background-executor` calls instead of constructing V1AgentRunner directly.
 *
 * Since THE FLIP the shipped production default (PRODUCTION_DEFAULT_FLAG_SET_ID =
 * `v2-all-routes+full-control-plane`) selects `V2AgentRunner` on every route; `V1AgentRunner` is
 * reached only under the revert flag sets (`all-v1` — also the bare `resolveFlagSetById(undefined)`
 * / test baseline — and `v1-driver+full-control-plane`). A route only runs V2 when its driver flag
 * is `"v2"`, which the closed `LEGAL_FLAG_SETS` matrix only permits alongside the FULL control
 * plane (V2 consumes it) — so a V2 route can never be reached without the control plane.
 *
 * Dependency rule (mirrors the rest of agent-core/runner): this imports ONLY agent-core modules +
 * a STRUCTURAL `RunnerHostOrchestrator` slice — never the concrete `Orchestrator` — so there is no
 * cycle. `control-plane.ts` imports the `ControlPlane` interface from `v2-agent-runner.ts` as a
 * type only, so the value import of `createControlPlane` here closes no loop.
 */

import { createControlPlane } from "../control/control-plane.js";
import type { Clock } from "../control/clock.js";
import type { HealthCore } from "../control/failure-ledger.js";
import type { PolicySeed } from "../control/policy.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { AgentRunner, RunnerMode } from "./agent-runner.js";
import type { FlagSet } from "./flags.js";
import type { OrchestratorPort } from "./orchestrator-port.js";
import { V1AgentRunner, type V1OrchestratorLike } from "./v1-agent-runner.js";
import { V2AgentRunner } from "./v2-agent-runner.js";

/**
 * The structural slice of the v1 `Orchestrator` the selector needs to build a V2 runner — declared
 * structurally (not by importing the concrete class) so `agent-core` stays cycle-free. The real
 * `Orchestrator` satisfies it (it has `getAgentCoreFlagSet`/`getAgentCoreClock`/`createAgentCorePort`).
 * All three are optional so a legacy/test orchestrator that lacks them simply falls through to v1.
 */
export interface RunnerHostOrchestrator extends V1OrchestratorLike {
  getAgentCoreFlagSet?(): FlagSet | undefined;
  getAgentCoreClock?(): Clock;
  createAgentCorePort?(): {
    port: OrchestratorPort;
    gateway: ModelGateway;
    seed: PolicySeed;
    createHealthCore: () => HealthCore;
  };
}

/**
 * RunnerMode → the FlagSet driver field that governs it. A `Record<RunnerMode, …>` so a NEW
 * RunnerMode is a COMPILE error here (forcing an explicit route mapping) rather than silently
 * defaulting to v1 — the exhaustiveness guarantee a `default:`-arm switch would lose.
 */
const ROUTE_FLAG_FIELD: Record<
  RunnerMode,
  "worker" | "supervisorNode" | "background" | "interactive"
> = {
  worker: "worker",
  "supervisor-node": "supervisorNode",
  background: "background",
  interactive: "interactive",
};

/** True when `mode`'s per-route driver flag is `"v2"` in the resolved set. */
function routeUsesV2(flagSet: FlagSet | undefined, mode: RunnerMode): boolean {
  return flagSet?.[ROUTE_FLAG_FIELD[mode]] === "v2";
}

/**
 * Select the runner for `mode`: `V2AgentRunner` when the route's driver flag is `"v2"` AND the
 * orchestrator exposes the V2 wiring hooks; otherwise the v1 pass-through. Per-call construction is
 * cheap (the port is a bundle of bound closures; the control plane is per-run state) and matches the
 * existing per-call `V1AgentRunner` construction the executor already did.
 */
export function selectAgentRunner(
  orchestrator: RunnerHostOrchestrator,
  mode: RunnerMode,
): AgentRunner {
  const flagSet = orchestrator.getAgentCoreFlagSet?.();
  if (
    routeUsesV2(flagSet, mode) &&
    typeof orchestrator.createAgentCorePort === "function" &&
    typeof orchestrator.getAgentCoreClock === "function"
  ) {
    const { port, gateway, seed, createHealthCore } = orchestrator.createAgentCorePort();
    const clock = orchestrator.getAgentCoreClock();
    const controlPlane = createControlPlane({ clock, seed, createHealthCore });
    return new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock });
  }
  return new V1AgentRunner(orchestrator as V1OrchestratorLike);
}
