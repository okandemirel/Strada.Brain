/**
 * The whole path, not the pieces.
 *
 * Every part of this was tested and every part passed: the refusal predicate,
 * the health registry, the assigner's liveness filter. The system still handed
 * three of four tasks to a provider that had been out of quota for hours,
 * across five consecutive runs, because the pieces were tested against each
 * other's stand-ins — a fake liveness predicate here, a hand-built registry
 * there — and never once against the real ones.
 *
 * This test wires them the way bootstrap does and asks the only question that
 * matters: after a provider says no, does it stop being given work?
 */

import { describe, expect, it, beforeEach } from "vitest";

import { recordProviderHealthFailure } from "../agents/orchestrator-runtime-utils.js";
import { ProviderHealthRegistry } from "../agents/providers/provider-health.js";
import { ProviderAssigner } from "./provider-assigner.js";

const CYCLE_403 =
  'Kimi (Moonshot) API error 403: {"error":{"message":"You\'ve reached your usage limit ' +
  'for this billing cycle. Your quota will be refreshed in the next cycle."}}';

const descriptors = [
  { name: "OpenCode (Zen/Go)", scores: { "code-gen": 0.9, "tool-use": 0.9 } },
  { name: "Kimi (Moonshot)", scores: { "code-gen": 0.9, "tool-use": 0.9 } },
] as never[];

const profile = {
  primary: ["code-gen"],
  preference: "quality",
  confidence: 0.9,
  source: "heuristic",
} as const;

function fourTasks(): never[] {
  return ["n1", "n2", "n3", "n4"].map(
    (id) =>
      ({
        id,
        task: "write a service",
        status: "pending",
        depth: 1,
        dependsOn: new Set<string>(),
        retryCount: 0,
        capabilityProfile: profile,
      }) as never,
  );
}

function distribution(assigner: ProviderAssigner): Record<string, number> {
  const out = assigner.assignNodes(fourTasks()) as unknown as Array<{
    assignedProvider?: string;
  }>;
  const counts: Record<string, number> = {};
  for (const node of out) {
    const key = node.assignedProvider ?? "(unassigned)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("a provider that refuses stops getting work", () => {
  beforeEach(() => {
    // The registry is a process-wide singleton; a leftover entry from another
    // test would make this pass for the wrong reason.
    ProviderHealthRegistry.resetInstance?.();
  });

  it("hands nothing to a provider that just exhausted its billing cycle", () => {
    // Built exactly as bootstrap builds it: no liveness argument, so the real
    // defaultLiveness consults the real singleton registry.
    const assigner = new ProviderAssigner(descriptors);
    const registry = ProviderHealthRegistry.getInstance();

    expect(distribution(assigner)["kimi"], "kimi should be usable before it refuses").toBeGreaterThan(
      0,
    );

    // The failure arrives on a direct per-task provider call — no chain around
    // it — which is how the supervisor calls an assigned provider.
    recordProviderHealthFailure(registry, "Kimi (Moonshot)", CYCLE_403, {
      isSingleProvider: true,
    });

    expect(distribution(assigner)["kimi"], "a dead provider is still being given goals").toBe(
      undefined,
    );
  });

  it("keeps the work moving instead of stalling", () => {
    const assigner = new ProviderAssigner(descriptors);
    recordProviderHealthFailure(
      ProviderHealthRegistry.getInstance(),
      "Kimi (Moonshot)",
      CYCLE_403,
      { isSingleProvider: true },
    );

    const after = distribution(assigner);

    expect(after["opencode"], "the live provider must absorb the work").toBe(4);
    expect(after["(unassigned)"]).toBe(undefined);
  });

  it("is still benched well beyond the short cooldown", () => {
    // The fifteen-minute bench is what let this repeat every quarter hour.
    const registry = ProviderHealthRegistry.getInstance();
    recordProviderHealthFailure(registry, "Kimi (Moonshot)", CYCLE_403, {
      isSingleProvider: true,
    });

    // Not "is it down now" — a fifteen-minute bench satisfies that too, and a
    // fifteen-minute bench is exactly what let this repeat every quarter hour.
    // Ask how long: a cycle quota must outlast anything measured in minutes.
    const until = registry.unavailableProviders().find((p) => p.startsWith("kimi"));
    const stamp = until?.match(/until (\S+)\)/u)?.[1];

    expect(stamp, "no expiry reported for a benched provider").toBeDefined();
    expect(
      new Date(stamp!).getTime() - Date.now(),
      "a billing-cycle quota was benched for minutes, not hours",
    ).toBeGreaterThan(60 * 60 * 1000);
  });
});
