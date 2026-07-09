/**
 * Agent Core v2 — the runner factory.
 *
 * `selectAgentRunner` constructs the V2AgentRunner over the host orchestrator's port/gateway
 * bundle. Cutover Step 5 deleted the v1 engine (runAgentLoop / runBackgroundTask /
 * V1AgentRunner), so there is no per-route selection left: every mode runs the V2 spine. The
 * `mode` parameter stays — it shapes the run policy + IOStrategy, not the engine choice.
 *
 * A host that lacks the V2 wiring hooks is a HARD ERROR (it would previously fall through to
 * the now-deleted v1 pass-through silently): test hosts must provide the real
 * `createAgentCorePort`/`getAgentCoreClock` (see v2-agent-runner.integration.test.ts's
 * buildHarness for the canonical construction).
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
import { V2AgentRunner } from "./v2-agent-runner.js";

/**
 * The structural slice of the `Orchestrator` the factory needs to build a V2 runner — declared
 * structurally (not by importing the concrete class) so `agent-core` stays cycle-free. The real
 * `Orchestrator` satisfies it. The wiring hooks are REQUIRED since the v1 pass-through fallback
 * was deleted (cutover Step 5); `getAgentCoreFlagSet` stays optional — the remaining legal sets
 * differ only in control-plane extras (scoring/capability/streaming), not in engine choice.
 */
export interface RunnerHostOrchestrator {
  getAgentCoreFlagSet?(): FlagSet | undefined;
  getAgentCoreClock(): Clock;
  createAgentCorePort(): {
    port: OrchestratorPort;
    gateway: ModelGateway;
    seed: PolicySeed;
    createHealthCore: () => HealthCore;
  };
}

/**
 * Construct the V2 runner for `mode`. Per-call construction is cheap (the port is a bundle of
 * bound closures; the control plane is per-run state). Throws a descriptive error when the host
 * lacks the V2 wiring hooks — a silent fallback no longer exists.
 */
export function selectAgentRunner(
  orchestrator: RunnerHostOrchestrator,
  mode: RunnerMode,
): AgentRunner {
  if (
    typeof orchestrator.createAgentCorePort !== "function" ||
    typeof orchestrator.getAgentCoreClock !== "function"
  ) {
    throw new Error(
      `selectAgentRunner(${mode}): the host orchestrator lacks the Agent Core wiring hooks ` +
        "(createAgentCorePort/getAgentCoreClock). The v1 pass-through was deleted in cutover " +
        "Step 5 — construct the host with the real port wiring (see " +
        "v2-agent-runner.integration.test.ts buildHarness).",
    );
  }
  const { port, gateway, seed, createHealthCore } = orchestrator.createAgentCorePort();
  const clock = orchestrator.getAgentCoreClock();
  const controlPlane = createControlPlane({ clock, seed, createHealthCore });
  return new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock });
}
