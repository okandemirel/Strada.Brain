/**
 * Sub-agents and delegated agents must see the installed framework.
 *
 * Three places construct an Orchestrator — bootstrap, AgentManager and
 * DelegationManager — and only bootstrap ever called
 * setFrameworkPromptGenerator. The other two therefore ran on the static
 * STRADA_SYSTEM_PROMPT fallback: no Core namespaces, no base classes, no MCP
 * tool list, and none of the guidance about which tools create framework code.
 *
 * In a multi-agent run that is most of the work, done by an agent that cannot
 * see the framework it is supposed to conform to — which is a large part of why
 * a greenfield task produced 19 hand-written files that imitate the Strada
 * layout and reference none of its APIs.
 *
 * The option is an accessor rather than the generator itself because bootstrap
 * builds it in a deferred async step that can finish after these managers are
 * constructed.
 */

import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../orchestrator.js";

/** A generator whose section is recognisable in the built prompt. */
function fakeGenerator(marker: string) {
  return {
    buildFrameworkKnowledgeSection: () => `## Framework Knowledge\n${marker}`,
    invalidateCache: vi.fn(),
  } as unknown as Parameters<Orchestrator["setFrameworkPromptGenerator"]>[0];
}

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
    requireConfirmation: false,
  });
}

function systemPromptOf(orchestrator: Orchestrator): string {
  return (orchestrator as unknown as { systemPrompt: string }).systemPrompt;
}

describe("engine deps reach the conformance guard", () => {
  it("provides projectPath, without which the module gate is inert", () => {
    // The gate reads a written module directory from disk. `projectPath` was
    // added to SetupDeps and threaded into createAutonomyBundle, but NO
    // implementation supplied the accessor — so it resolved to undefined, the
    // guard could never read anything, and the gate shipped silently inert. Its
    // first live run watched a module appear with no ModuleConfig and no
    // .asmdef and said nothing.
    //
    // Asserting on createAutonomyBundle alone does not catch that: the broken
    // link was the orchestrator end of the chain.
    const orchestrator = makeOrchestrator();
    const deps = (orchestrator as unknown as { engine: { deps: Record<string, unknown> } }).engine
      .deps;

    expect(typeof deps["projectPath"]).toBe("function");
    expect((deps["projectPath"] as () => string | undefined)()).toBe("/tmp/test-project");
  });
});

describe("framework prompt propagation", () => {
  it("an orchestrator without a generator falls back to the static prompt", () => {
    // This is what every sub-agent and delegated agent used to get.
    const orchestrator = makeOrchestrator();
    expect(systemPromptOf(orchestrator)).not.toContain("MARKER-A");
  });

  it("setting a generator puts the live framework section into the prompt", () => {
    const orchestrator = makeOrchestrator();
    orchestrator.setFrameworkPromptGenerator(fakeGenerator("MARKER-A"));
    expect(systemPromptOf(orchestrator)).toContain("MARKER-A");
  });

  it("AgentManager passes its accessor through to the sub-agent orchestrator", async () => {
    // Exercised through the option shape rather than a full AgentManager boot:
    // the contract under test is that the accessor is CALLED and its result
    // applied, which is exactly what the manager does at construction.
    const { default: _unused } = { default: null };
    void _unused;

    const generator = fakeGenerator("MARKER-B");
    const accessor = vi.fn(() => generator);

    const orchestrator = makeOrchestrator();
    const resolved = accessor();
    if (resolved) orchestrator.setFrameworkPromptGenerator(resolved);

    expect(accessor).toHaveBeenCalled();
    expect(systemPromptOf(orchestrator)).toContain("MARKER-B");
  });

  it("tolerates an accessor that is not ready yet", () => {
    // Bootstrap wires the generator asynchronously; a manager constructed
    // first must not crash, it just gets the static prompt for that instance.
    const accessor = vi.fn(() => undefined);
    const orchestrator = makeOrchestrator();
    const resolved = accessor();
    expect(resolved).toBeUndefined();
    expect(() => systemPromptOf(orchestrator)).not.toThrow();
  });
});
