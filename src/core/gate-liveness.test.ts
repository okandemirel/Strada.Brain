import { describe, it, expect } from "vitest";
import { probeGateLiveness, summarizeGateLiveness } from "./gate-liveness.js";

describe("gate liveness", () => {
  // Measured 2026-09-07: two gates dead for a campaign, every test green.
  it("every gate fires on its own fixture in this process", () => {
    const probes = probeGateLiveness();
    const { summary, dead } = summarizeGateLiveness(probes);
    expect(dead, probes.map((p) => `${p.gate}: ${p.detail}`).join("\n")).toEqual([]);
    expect(summary).toBe(`Gate liveness: ${probes.length}/${probes.length} gates fire on their fixtures`);
    expect(probes.length).toBeGreaterThanOrEqual(6);
  });
});
