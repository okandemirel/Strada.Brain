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

  // Measured 2026-09-07 (CI run 34134720501): the catalog supports nothing on
  // the Linux runner, defaultModelFor() is undefined there, and the probe
  // threw — a dead gate on CI, a live one on the laptop.
  it("survives a device the model catalog does not support, and says what it could not prove", () => {
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    try {
      const probes = probeGateLiveness();
      const { dead } = summarizeGateLiveness(probes);
      expect(dead, probes.map((p) => `${p.gate}: ${p.detail}`).join("\n")).toEqual([]);
      const local = probes.find((p) => p.gate === "local model availability");
      expect(local?.detail).toContain("catalog offers no text-to-image model on this device");
    } finally {
      Object.defineProperty(process, "arch", arch);
    }
  });
});
