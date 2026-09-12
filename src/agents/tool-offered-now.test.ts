/**
 * What "offered" means when a gate asks.
 *
 * The evidence gate refuses to demand a tool this run does not have — but an
 * unknown NAME used to answer "offered", so a plan naming a tool nothing ever
 * registered still rejected the node for not calling it: the unsatisfiable gate
 * again (Codex 2026-09-12 S#12).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLogger } from "../utils/logger.js";
import { Orchestrator } from "./orchestrator.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function makeOrchestrator(): Orchestrator {
  const provider = {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
    healthCheck: vi.fn(),
  };
  return new Orchestrator({
    providerManager: {
      getProvider: () => provider,
      getProviderByName: () => provider,
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      listAvailable: () => [{ name: "mock", label: "mock", defaultModel: "default" }],
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { sendMessage: vi.fn(), type: "cli" } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: true,
  });
}

describe("toolOfferedNow", () => {
  it("answers 'not offered' for a name nothing registered", () => {
    const orchestrator = makeOrchestrator();
    const answer = orchestrator.toolOfferedNow("unity_tool_that_does_not_exist");
    expect(answer.offered).toBe(false);
    expect(answer.reason).toContain("not a tool this run has");
  });

  it("answers 'offered' for a tool the run actually carries", () => {
    const orchestrator = makeOrchestrator();
    // A tool registered for this run, with no metadata of its own.
    (orchestrator as unknown as { toolDefinitions: Array<{ name: string }> })
      .toolDefinitions.push({ name: "unity_scene_build" });
    expect(orchestrator.toolOfferedNow("unity_scene_build")).toMatchObject({ offered: true });
    expect(orchestrator.offeredToolNames()).toContain("unity_scene_build");
  });

  it("reports a bridge-gated tool's own reason when one is recorded", () => {
    const orchestrator = makeOrchestrator();
    (orchestrator as unknown as {
      toolMetadataByName: Map<string, { available?: boolean; availabilityReason?: string }>;
    }).toolMetadataByName.set("unity_create_scene", {
      available: false,
      availabilityReason: "the Unity bridge is not connected",
    });
    expect(orchestrator.toolOfferedNow("unity_create_scene")).toEqual({
      offered: false,
      reason: "the Unity bridge is not connected",
    });
  });
});
