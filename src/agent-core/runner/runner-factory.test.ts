/**
 * Agent Core v2 — selectAgentRunner factory tests.
 *
 * Cutover Step 5 deleted the v1 pass-through: the factory ALWAYS constructs V2AgentRunner over
 * the host's port/gateway bundle, and a host lacking the wiring hooks is a HARD, descriptive
 * error (previously a silent v1 fallback — the worst failure mode after the engine deletion).
 */

import { describe, it, expect } from "vitest";
import { FakeClock } from "../control/clock.js";
import { selectAgentRunner, type RunnerHostOrchestrator } from "./runner-factory.js";
import { V2AgentRunner } from "./v2-agent-runner.js";
import type { OrchestratorPort } from "./orchestrator-port.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { PolicySeed } from "../control/policy.js";
import type { HealthCore } from "../control/failure-ledger.js";

/** A host orchestrator exposing the V2 wiring hooks (stubs — construction only stores them). */
function mkHost(): RunnerHostOrchestrator {
  return {
    getAgentCoreClock: () => new FakeClock(0),
    // createControlPlane only STORES seed/createHealthCore at construction (calls them in
    // openRun), and new V2AgentRunner only stores its deps — opaque stubs suffice.
    createAgentCorePort: () => ({
      port: {} as OrchestratorPort,
      gateway: {} as ModelGateway,
      seed: {} as PolicySeed,
      createHealthCore: () => ({}) as HealthCore,
    }),
  };
}

describe("selectAgentRunner", () => {
  it.each(["worker", "supervisor-node", "background", "interactive"] as const)(
    "constructs V2AgentRunner for the %s mode",
    (mode) => {
      expect(selectAgentRunner(mkHost(), mode)).toBeInstanceOf(V2AgentRunner);
    },
  );

  it("throws a descriptive error when the host lacks createAgentCorePort", () => {
    const host = { getAgentCoreClock: () => new FakeClock(0) } as unknown as RunnerHostOrchestrator;
    expect(() => selectAgentRunner(host, "worker")).toThrow(/wiring hooks/);
    expect(() => selectAgentRunner(host, "worker")).toThrow(/Step 5/);
  });

  it("throws a descriptive error when the host lacks getAgentCoreClock", () => {
    const host = {
      createAgentCorePort: mkHost().createAgentCorePort,
    } as unknown as RunnerHostOrchestrator;
    expect(() => selectAgentRunner(host, "interactive")).toThrow(/wiring hooks/);
  });

  it("constructs a fresh runner per call (per-call construction is the contract)", () => {
    const host = mkHost();
    const a = selectAgentRunner(host, "worker");
    const b = selectAgentRunner(host, "worker");
    expect(a).not.toBe(b);
  });
});
