/**
 * A provider that dies mid-run stops receiving work.
 *
 * The descriptors are built once, at bootstrap. Measured 2026-08-21, run 30:
 * Kimi was out of quota before the run even started, the descriptor said
 * nothing about it, and five goals were assigned to it — each failed with a
 * 403, fell back to itself, and blocked. OpenCode was healthy throughout and
 * was given none of them. The requirement is not "check at startup": it is that
 * work moves while goals and tasks are already in flight.
 */

import { describe, expect, it } from "vitest";

import { ProviderAssigner } from "./provider-assigner.js";

const descriptors = [
  { name: "opencode", scores: { "code-gen": 0.9, "tool-use": 0.9 } },
  { name: "kimi", scores: { "code-gen": 0.9, "tool-use": 0.9 } },
] as never[];

const profile = {
  primary: ["code-gen"],
  preference: "quality",
  confidence: 0.9,
  source: "heuristic",
} as const;

const node = (id: string, task: string) =>
  ({
    id,
    task,
    status: "pending",
    depth: 1,
    dependsOn: new Set<string>(),
    parentId: undefined,
    result: undefined,
    error: undefined,
    retryCount: 0,
    capabilityProfile: profile,
  }) as never;

const nodes = [
  node("n1", "write the board service"),
  node("n2", "write the pig service"),
  node("n3", "write the scoring service"),
] as never[];

function assignedNames(assigner: ProviderAssigner): string[] {
  const out = assigner.assignNodes(nodes) as unknown as Array<{ assignedProvider?: string }>;
  return out.map((n) => n.assignedProvider ?? "(none)");
}

describe("assigning work while a provider is down", () => {
  it("gives nothing to a provider that is not live right now", () => {
    const assigner = new ProviderAssigner(descriptors, (name) => name !== "kimi");

    expect(assignedNames(assigner)).not.toContain("kimi");
  });

  it("asks again for every assignment, not once at construction", () => {
    // A provider can die between one goal and the next; a snapshot taken in the
    // constructor would keep feeding it.
    let kimiLive = true;
    const assigner = new ProviderAssigner(descriptors, (name) => name !== "kimi" || kimiLive);

    assignedNames(assigner);
    kimiLive = false;

    expect(assignedNames(assigner)).not.toContain("kimi");
  });

  it("still assigns when every provider is live", () => {
    const assigner = new ProviderAssigner(descriptors, () => true);

    expect(assignedNames(assigner).filter((n) => n !== "(none)").length).toBeGreaterThan(0);
  });
});
