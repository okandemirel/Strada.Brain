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

function makeOrchestrator(toolMetadataByName?: Map<string, never>): Orchestrator {
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
    ...(toolMetadataByName ? { toolMetadataByName } : {}),
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

/**
 * Codex round AE#5, reproduced: register a bridge tool while disconnected,
 * then reconnect — the registry's metadata says available again, and the
 * orchestrator still answered `offered: false, reason: "Bridge disconnected"`,
 * because it had copied the metadata into a map of its own.
 */
describe("availability as it is NOW (Codex 2026-09-12 AE#5)", () => {
  it("follows the registry's map when the bridge comes back", () => {
    const registry = new Map<string, never>();
    registry.set("unity_create_scene", { available: false, availabilityReason: "Bridge disconnected" } as never);
    const orchestrator = makeOrchestrator(registry);
    expect(orchestrator.toolOfferedNow("unity_create_scene")).toEqual({
      offered: false,
      reason: "Bridge disconnected",
    });

    // The editor reconnects: the registry rewrites the same entry.
    registry.set("unity_create_scene", { available: true, availabilityReason: undefined } as never);
    expect(orchestrator.toolOfferedNow("unity_create_scene")).toMatchObject({ offered: true });

    // …and it follows the registry in the other direction too.
    registry.set("unity_create_scene", { available: false, availabilityReason: "the editor went away again" } as never);
    expect(orchestrator.toolOfferedNow("unity_create_scene")).toEqual({
      offered: false,
      reason: "the editor went away again",
    });
  });

  it("keeps a tool the registry does not know at its own recorded availability", () => {
    const registry = new Map<string, never>();
    const orchestrator = makeOrchestrator(registry);
    (orchestrator as unknown as {
      toolMetadataByName: Map<string, { available?: boolean; availabilityReason?: string }>;
    }).toolMetadataByName.set("unity_local_only", {
      available: false,
      availabilityReason: "no local model is installed",
    });
    expect(orchestrator.toolOfferedNow("unity_local_only")).toEqual({
      offered: false,
      reason: "no local model is installed",
    });
  });
});
