/**
 * Agent Core v2 — selectAgentRunner route-selector tests.
 *
 * Proves the Phase-2 flip mechanism: a route flips to V2AgentRunner ONLY when its driver flag is
 * "v2" AND the orchestrator exposes the V2 wiring hooks; everything else (default all-v1, missing
 * hooks, a different route's flag) falls through to the v1 pass-through — byte-identical to today.
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { selectAgentRunner, type RunnerHostOrchestrator } from "./runner-factory.js";
import { V1AgentRunner } from "./v1-agent-runner.js";
import { V2AgentRunner } from "./v2-agent-runner.js";
import type { FlagSet } from "./flags.js";
import type { OrchestratorPort } from "./orchestrator-port.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { PolicySeed } from "../control/policy.js";
import type { HealthCore } from "../control/failure-ledger.js";

/** A FlagSet with every route "v1" + the FULL control plane, overridable per test. */
function mkFlags(over: Partial<FlagSet> = {}): FlagSet {
  return {
    id: "test",
    interactive: "v1",
    background: "v1",
    worker: "v1",
    supervisorNode: "v1",
    failureLedger: true,
    runClock: true,
    silenceAccumulator: true,
    typedCancelReason: true,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
    ...over,
  };
}

/** A host orchestrator exposing the V2 hooks. `flagSet` controls the routing; hooks return stubs. */
function mkHost(opts: {
  flagSet?: FlagSet | undefined;
  withV2Hooks?: boolean;
} = {}): RunnerHostOrchestrator {
  const withV2Hooks = opts.withV2Hooks ?? true;
  const host: RunnerHostOrchestrator = {
    // V1OrchestratorLike surface (enough for V1AgentRunner construction).
    runWorkerTask: vi.fn(async () => ({}) as never),
    getAgentCoreFlagSet: () => opts.flagSet,
  };
  if (withV2Hooks) {
    host.getAgentCoreClock = () => new FakeClock(0);
    // createControlPlane only STORES seed/createHealthCore at construction (calls them in openRun),
    // and new V2AgentRunner only stores its deps — so opaque stubs suffice for the instanceof check.
    host.createAgentCorePort = () => ({
      port: {} as OrchestratorPort,
      gateway: {} as ModelGateway,
      seed: {} as PolicySeed,
      createHealthCore: () => ({}) as HealthCore,
    });
  }
  return host;
}

describe("selectAgentRunner — Phase-2 route selector (default-off)", () => {
  it("no flag set → V1AgentRunner (the default all-v1 path)", () => {
    expect(selectAgentRunner(mkHost({ flagSet: undefined }), "worker")).toBeInstanceOf(V1AgentRunner);
  });

  it("worker route 'v1' → V1AgentRunner", () => {
    const host = mkHost({ flagSet: mkFlags({ worker: "v1" }) });
    expect(selectAgentRunner(host, "worker")).toBeInstanceOf(V1AgentRunner);
  });

  it("worker route 'v2' + V2 hooks present → V2AgentRunner", () => {
    const host = mkHost({ flagSet: mkFlags({ worker: "v2" }) });
    expect(selectAgentRunner(host, "worker")).toBeInstanceOf(V2AgentRunner);
  });

  it("supervisor-node route 'v2' → V2AgentRunner", () => {
    const host = mkHost({ flagSet: mkFlags({ supervisorNode: "v2" }) });
    expect(selectAgentRunner(host, "supervisor-node")).toBeInstanceOf(V2AgentRunner);
  });

  it("route isolation: worker 'v2' does NOT flip the interactive route", () => {
    const host = mkHost({ flagSet: mkFlags({ worker: "v2" }) }); // interactive stays "v1"
    expect(selectAgentRunner(host, "interactive")).toBeInstanceOf(V1AgentRunner);
  });

  it("graceful fallback: worker 'v2' but the orchestrator lacks createAgentCorePort → V1AgentRunner", () => {
    const host = mkHost({ flagSet: mkFlags({ worker: "v2" }), withV2Hooks: false });
    expect(selectAgentRunner(host, "worker")).toBeInstanceOf(V1AgentRunner);
  });
});
