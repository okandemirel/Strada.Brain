import { describe, expect, it } from "vitest";

/**
 * Supervisor node assignment must reflect what a model is GOOD at, not only
 * what it CAN do. Before this, buildProviderDescriptors scored providers from
 * binary capability flags, so every tool-calling model tied and nodes were
 * distributed by availability — the 12-dimension behavioral profiles that
 * already drive the router were invisible to the supervisor.
 */
describe("supervisor provider descriptors", () => {
  it("lifts capability scores from behavioral profiles (claude plans, openai implements)", async () => {
    const { buildProviderDescriptors: build } = await import("./stage-supervisor.js");

    const providerManager = {
      listAvailable: () => [
        { name: "claude", defaultModel: "sonnet" },
        { name: "openai", defaultModel: "gpt" },
      ],
      getProviderCapabilities: () => ({ toolCalling: true, vision: false, thinkingSupported: false, contextWindow: 200000 }),
    };
    const descriptors = build(providerManager as never);
    const claude = descriptors.find((d) => d.name === "claude")!;
    const openai = descriptors.find((d) => d.name === "openai")!;
    expect(claude.scores["reasoning"]).toBeGreaterThan(openai.scores["reasoning"]);
    expect(openai.scores["speed"]).toBeGreaterThan(claude.scores["speed"]);
  });
});
