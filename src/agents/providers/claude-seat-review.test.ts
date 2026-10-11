import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAIProvider } from "./provider.interface.js";

/**
 * "anthropic" and "claude" are two spellings of one Claude seat. The manager
 * names the seat after the chain in listExecutionCandidates ("anthropic" for
 * PROVIDER_CHAIN=anthropic) but always as "claude" in listAvailable and
 * listRoutable. A reviewer picker that compares the two lists by spelling
 * sees two providers. Measured on the real manager: the consensus reviewer
 * was the Claude seat reviewing its own work "to keep consensus verification
 * cross-provider", and the node verifier approved a "claude" node through
 * "anthropic" with no independent:false caveat.
 */

const { buildProviderChainMock } = vi.hoisted(() => ({ buildProviderChainMock: vi.fn() }));

function makeProvider(name: string): IAIProvider {
  return {
    name,
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn().mockResolvedValue({ text: '{"verdict":"approve"}', toolCalls: [], stopReason: "end_turn" }),
  };
}

vi.mock("./provider-registry.js", () => ({
  PROVIDER_PRESETS: {
    openai: { baseUrl: "https://example.test/openai", defaultModel: "gpt-5.4", label: "OpenAI" },
  },
  buildProviderChain: buildProviderChainMock,
  createProvider: vi.fn(({ name }: { name: string }) => makeProvider(name)),
}));

vi.mock("./provider-preferences.js", () => ({
  ProviderPreferenceStore: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn(),
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(),
      getMostRecent: vi.fn(() => undefined),
      close: vi.fn(),
    };
  }),
}));

vi.mock("../../utils/logger.js", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLoggerSafe: () => log, getLogger: () => log };
});

import { ProviderManager } from "./provider-manager.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { providerRecordKey } from "./provider-identity.js";
import { resolveConsensusReviewAssignment, type SupervisorAssignment } from "../orchestrator-supervisor-routing.js";
import { createSupervisorNodeVerifier } from "../../supervisor/supervisor-verification.js";
import type { NodeResult } from "../../supervisor/supervisor-types.js";

// Production credentials carry the seat under both keys (collectProviderCredentials).
const CREDENTIALS = {
  claude: { apiKey: "anthropic-key" },
  anthropic: { apiKey: "anthropic-key" },
  openai: { apiKey: "openai-key" },
};

function manager(chain: string[], strict: boolean): ProviderManager {
  return new ProviderManager(
    makeProvider(`chain(${chain.join("->")})`),
    CREDENTIALS,
    undefined,
    "/tmp/claude-seat-review-test",
    chain,
    undefined,
    undefined,
    undefined,
    strict,
  );
}

/** The executor the router picks: its pool is listExecutionCandidates. */
function executorOf(m: ProviderManager): SupervisorAssignment {
  const name = m.listExecutionCandidates("chat:web:1")[0]!.name;
  return { role: "executor", providerName: name, provider: makeProvider(name), reason: "routed" };
}

function node(provider: string): NodeResult {
  return {
    nodeId: "node-1" as NodeResult["nodeId"],
    status: "ok",
    output: "Implemented the endpoint.",
    artifacts: [],
    toolResults: [],
    provider,
    model: "claude-x",
    cost: 0,
    duration: 1,
  };
}

beforeEach(() => {
  ProviderHealthRegistry.resetInstance();
  buildProviderChainMock.mockReset();
  buildProviderChainMock.mockImplementation((order: string[]) => makeProvider(`chain(${order.join("->")})`));
});

describe("the consensus reviewer is never the executor's own seat", () => {
  it("PROVIDER_CHAIN=anthropic strict: no other seat exists, so no cross-provider reviewer is claimed", () => {
    const m = manager(["anthropic"], true);
    const executor = executorOf(m);
    const ctx = { providerManager: m } as any;

    expect(resolveConsensusReviewAssignment(ctx, executor, executor, "chat:web:1")).toBeNull();
    // The strategy's reviewer under the other spelling is the same seat, not an alternate.
    const sameSeat = { ...executor, role: "reviewer" as const, providerName: "claude" };
    expect(resolveConsensusReviewAssignment(ctx, sameSeat, executor, "chat:web:1")).toBeNull();
  });

  it.each([true, false])("PROVIDER_CHAIN=anthropic,openai (strict=%s): the alternate reviewer is openai", (strict) => {
    const m = manager(["anthropic", "openai"], strict);
    const executor = executorOf(m);
    const ctx = { providerManager: m } as any;

    const reviewer = resolveConsensusReviewAssignment(ctx, executor, executor, "chat:web:1");
    expect(reviewer?.providerName).toBe("openai");
    // getProviderByName hands out a chain; what matters here is its head.
    expect(reviewer?.provider.name).toMatch(/^chain\(openai\b/);

    const sameSeat = { ...executor, role: "reviewer" as const, providerName: "claude" };
    expect(resolveConsensusReviewAssignment(ctx, sameSeat, executor, "chat:web:1")?.providerName).toBe("openai");
  });

  it("a reviewer on another seat is kept as the strategy chose it", () => {
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const openai = { role: "reviewer" as const, providerName: "openai", provider: makeProvider("openai"), reason: "routed" };
    expect(resolveConsensusReviewAssignment({ providerManager: m } as any, openai, executor, "chat:web:1")).toBe(openai);
  });
});

describe("the node verifier never calls the worker's own seat independent", () => {
  it.each(["claude", "anthropic"])("PROVIDER_CHAIN=anthropic strict: a %s node is reviewed by its own seat and says so", async (spelling) => {
    const verify = createSupervisorNodeVerifier(manager(["anthropic"], true));
    const verdict = await verify(node(spelling), { chatId: "chat:web:1" } as any);

    expect(verdict.independent).toBe(false);
    expect(verdict.verifierProvider).toContain("same provider");
  });

  it.each([
    ["claude", true],
    ["anthropic", true],
    ["claude", false],
    ["anthropic", false],
  ])("PROVIDER_CHAIN=anthropic,openai: a %s node is verified by openai (strict=%s)", async (spelling, strict) => {
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], strict as boolean));
    const verdict = await verify(node(spelling as string), { chatId: "chat:web:1" } as any);

    expect(verdict.verifierProvider).toBe("openai");
    expect(verdict.verdict).toBe("approve");
    expect(verdict.independent).toBeUndefined();
  });

  it("an openai node on the same chain is verified by the Claude seat", async () => {
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], true));
    const verdict = await verify(node("openai"), { chatId: "chat:web:1" } as any);

    expect(providerRecordKey(verdict.verifierProvider)).toBe("claude");
    expect(verdict.independent).toBeUndefined();
  });
});
