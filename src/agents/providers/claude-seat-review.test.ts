import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAIProvider, ProviderResponse } from "./provider.interface.js";

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

const { buildProviderChainMock, createProviderMock } = vi.hoisted(() => ({
  buildProviderChainMock: vi.fn(),
  createProviderMock: vi.fn(),
}));

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
    deepseek: { baseUrl: "https://example.test/deepseek", defaultModel: "deepseek-x", label: "DeepSeek" },
  },
  buildProviderChain: buildProviderChainMock,
  createProvider: createProviderMock,
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
import { runConsensusVerification } from "../orchestrator-consensus.js";
import { ConsensusManager } from "../../agent-core/routing/consensus-manager.js";
import { createSupervisorNodeVerifier } from "../../supervisor/supervisor-verification.js";
import type { NodeResult } from "../../supervisor/supervisor-types.js";
import type { TaskUsageEvent } from "../../tasks/types.js";

// Production credentials carry the seat under both keys (collectProviderCredentials).
const CREDENTIALS = {
  claude: { apiKey: "anthropic-key" },
  anthropic: { apiKey: "anthropic-key" },
  openai: { apiKey: "openai-key" },
};

function manager(chain: string[], strict: boolean, credentials: Record<string, { apiKey: string }> = CREDENTIALS): ProviderManager {
  return new ProviderManager(
    makeProvider(`chain(${chain.join("->")})`),
    credentials,
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
  createProviderMock.mockReset();
  createProviderMock.mockImplementation(({ name }: { name: string }) => makeProvider(name));
});

/**
 * Seats that answer the way the real registry builds them: every call is
 * logged in `served`, a seat down at call time throws (`callError`, a 503 by
 * default), one down at build time cannot be created, a seat in `replies`
 * answers 200 with that text, a bare seat may carry its display label as
 * createProvider gives it, and a chain falls over member by member as
 * FallbackChainProvider does after skipping the members it could not create.
 */
function liveSeats(down: {
  atCall?: string[];
  atBuild?: string[];
  callError?: (name: string) => Error;
  replies?: Record<string, string>;
  labels?: Record<string, string>;
}): { served: string[] } {
  const served: string[] = [];
  const seat = (name: string): IAIProvider => {
    if (down.atBuild?.includes(name)) throw new Error(`${name}: no usable credential`);
    return {
      ...makeProvider(down.labels?.[name] ?? name),
      chat: vi.fn(async (): Promise<ProviderResponse> => {
        served.push(name);
        if (down.atCall?.includes(name)) throw down.callError?.(name) ?? new Error(`${name}: 503 service unavailable`);
        return {
          text: down.replies?.[name] ?? '{"verdict":"approve","approved":true,"reasoning":"looks right"}',
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }),
    };
  };
  createProviderMock.mockImplementation(({ name }: { name: string }) => seat(name));
  buildProviderChainMock.mockImplementation((order: string[]) => {
    const members = order.flatMap((name) => {
      try {
        return [{ name, provider: seat(name) }];
      } catch {
        return [];
      }
    });
    return {
      ...makeProvider(`chain(${order.join("->")})`),
      chat: vi.fn(async (...args: Parameters<IAIProvider["chat"]>) => {
        for (const member of members) {
          try {
            const response = await member.provider.chat(...args);
            return { ...response, servedBy: { provider: member.name, model: "m" } };
          } catch {
            /* the next member answers */
          }
        }
        throw new Error("chain exhausted");
      }),
    };
  });
  return { served };
}

async function consensusOn(executor: SupervisorAssignment, reviewer: SupervisorAssignment | null) {
  const outcomes: Array<{ providerName: string; status: string }> = [];
  const usages: TaskUsageEvent[] = [];
  const verdict = await runConsensusVerification({
    consensusManager: new ConsensusManager({ mode: "always", reviewTimeoutMs: 0 }),
    availableProviderCount: 2,
    taskClass: { type: "code-generation", complexity: "simple", criticality: "critical" },
    confidence: 0.9,
    originalOutput: { text: "Implemented the endpoint." },
    originalProviderName: executor.providerName,
    prompt: "Add the endpoint",
    reviewAssignment: reviewer,
    identityKey: "chat:web:1",
    recordExecutionTrace: () => {},
    onUsage: (usage) => usages.push(usage),
    recordPhaseOutcome: (p) => outcomes.push({ providerName: p.assignment.providerName, status: p.status }),
  });
  return { verdict, outcomes, usages };
}

const seatsOf = (served: string[]) => served.map((name) => providerRecordKey(name));

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
    // The head seat, whatever wraps it.
    expect(reviewer?.provider.name).toMatch(/^(chain\()?openai\b/);

    const sameSeat = { ...executor, role: "reviewer" as const, providerName: "claude" };
    expect(resolveConsensusReviewAssignment(ctx, sameSeat, executor, "chat:web:1")?.providerName).toBe("openai");
  });

  it("a reviewer on another seat is kept as the strategy chose it", () => {
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const openai = { role: "reviewer" as const, providerName: "openai", modelId: "gpt-5.4", provider: makeProvider("openai"), reason: "routed" };
    expect(resolveConsensusReviewAssignment({ providerManager: m } as any, openai, executor, "chat:web:1")).toMatchObject({
      role: "reviewer",
      providerName: "openai",
      modelId: "gpt-5.4",
      reason: "routed",
    });
  });
});

describe("a consensus review recorded as openai is never answered by the executor's seat", () => {
  it("the alternate reviewer: openai fails at call time, and the review fails closed instead of falling over", async () => {
    const { served } = liveSeats({ atCall: ["openai"] });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const reviewer = resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1");
    expect(reviewer?.providerName).toBe("openai");

    const { verdict, outcomes } = await consensusOn(executor, reviewer);

    expect(seatsOf(served)).not.toContain(providerRecordKey(executor.providerName));
    // Nothing reviewed: no verdict to act on, and the reviewer's phase failed.
    expect(verdict).toBeUndefined();
    expect(outcomes).toEqual([{ providerName: "openai", status: "failed" }]);
  });

  it("the strategy's reviewer on another seat: the chain resolveSupervisorAssignment built is not what reviews", async () => {
    const { served } = liveSeats({ atCall: ["openai"] });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const routed: SupervisorAssignment = {
      role: "reviewer",
      providerName: "openai",
      provider: m.getProviderByName("openai")!,
      reason: "routed to openai for code review",
    };
    const reviewer = resolveConsensusReviewAssignment({ providerManager: m } as any, routed, executor, "chat:web:1");
    expect(reviewer).toMatchObject({ providerName: "openai", reason: routed.reason });

    const { verdict } = await consensusOn(executor, reviewer);

    expect(seatsOf(served)).not.toContain(providerRecordKey(executor.providerName));
    expect(verdict).toBeUndefined();
  });

  it("a healthy openai reviews on its own and its approval stands", async () => {
    const { served } = liveSeats({});
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const reviewer = resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1");

    const { verdict } = await consensusOn(executor, reviewer);

    expect(served).toEqual(["openai"]);
    expect(verdict?.agreed).toBe(true);
  });

  it("a benched openai is not picked: a bare reviewer has no chain to step past the bench", () => {
    liveSeats({});
    ProviderHealthRegistry.getInstance().recordCredentialRejected("openai", "401 invalid key");
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);

    expect(resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1")).toBeNull();
  });

  it("an openai that cannot be built gives no reviewer, not a chain of the seats that remain", () => {
    liveSeats({ atBuild: ["openai"] });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);

    expect(resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1")).toBeNull();
  });

  it("a seat that cannot be built does not end the search while another seat can review", () => {
    liveSeats({ atBuild: ["openai"] });
    const m = manager(["anthropic", "openai", "deepseek"], true, { ...CREDENTIALS, deepseek: { apiKey: "deepseek-key" } });
    const executor = executorOf(m);

    const reviewer = resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1");
    expect(reviewer?.providerName).toBe("deepseek");
    expect(reviewer?.provider.name).toBe("deepseek");
  });
});

/**
 * A bare reviewer has no chain to record its health: FallbackChainProvider
 * benches the members it calls, a provider called on its own benches nothing.
 * The health gate in resolveConsensusReviewAssignment then only ever saw
 * benches some chain had recorded, so a reviewer seat with a dead key was
 * called on every critical step, and each failed call came back as
 * agreed:false, which tool-turn injects as "[CONSENSUS REVIEWER OBJECTION]
 * A second model reviewed the last critical step and disagreed".
 */
describe("a bare reviewer that fails at call time", () => {
  it.each([
    ["overloaded (503)", (name: string) => new Error(`${name}: 503 service unavailable`)],
    ["a refused key (401)", (name: string) => Object.assign(new Error(`${name} API error 401: invalid key`), { status: 401 })],
  ])("%s: its own failure benches it, so the next critical steps do not call it again", async (_label, callError) => {
    // Bare seats carry their display label, as createProvider names them.
    const { served } = liveSeats({ atCall: ["openai"], callError, labels: { openai: "OpenAI" } });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const ctx = { providerManager: m } as any;

    const reviewers: Array<string | undefined> = [];
    for (let check = 0; check < 3; check += 1) {
      const reviewer = resolveConsensusReviewAssignment(ctx, executor, executor, "chat:web:1");
      reviewers.push(reviewer?.providerName);
      await consensusOn(executor, reviewer);
    }

    expect(served).toEqual(["openai"]);
    expect(reviewers).toEqual(["openai", undefined, undefined]);
    expect(ProviderHealthRegistry.getInstance().isAvailable("openai")).toBe(false);
  });

  it("its outage is reported as no review, not as a second model's objection", async () => {
    liveSeats({ atCall: ["openai"] });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const reviewer = resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1");

    const { verdict, outcomes } = await consensusOn(executor, reviewer);

    expect(verdict).toBeUndefined();
    expect(outcomes).toEqual([{ providerName: "openai", status: "failed" }]);
  });

  it("a reviewer that answers is healthy again: an old blip does not count toward a bench", async () => {
    liveSeats({ labels: { openai: "OpenAI" } });
    ProviderHealthRegistry.getInstance().recordFailure("openai", "a blip");
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);

    const { verdict } = await consensusOn(executor, resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1"));

    expect(verdict?.agreed).toBe(true);
    expect(ProviderHealthRegistry.getInstance().getEntry("openai")?.consecutiveFailures).toBe(0);
  });

  it.each([
    ["overloaded (503)", "openai: 503 service unavailable", 5 * 60_000],
    ["a quota wall (403)", "openai API error 403: quota exceeded for this key", 8 * 60 * 60_000],
  ])("%s: benched as long as the executor's chain benches its member, since consensus only runs beside another seat", async (_label, message, chainBenchMs) => {
    const callError = () => Object.assign(new Error(message), { status: Number(/\b(\d{3})\b/.exec(message)![1]) });
    liveSeats({ atCall: ["openai"], callError, labels: { openai: "OpenAI" } });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);

    const before = Date.now();
    await consensusOn(executor, resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1"));

    // The short, non-escalating benches are for a setup with no other seat.
    expect(ProviderHealthRegistry.getInstance().getEntry("openai")!.cooldownUntil - before).toBeGreaterThanOrEqual(chainBenchMs);
  });
});

/**
 * An empty 200 is a failure of the seat as FallbackChainProvider judges it:
 * the chain throws "returned an empty response" and records the member, and
 * reasoning spliced into the text with no answer after it is no answer. Called
 * bare, the reviewer's empty reply was recorded as nothing and parsed as
 * agreed:false, so every critical step drew "[CONSENSUS REVIEWER OBJECTION] A
 * second model reviewed the last critical step and disagreed: " with nothing
 * after it, and the seat stayed available to be asked again.
 */
describe("a bare reviewer that answers with nothing", () => {
  it.each([
    ["an empty reply", ""],
    ["a reasoning block cut off before any verdict", "<reasoning>Do I agree with the endpoint change? First the retry path"],
  ])("%s is no review, and repeated ones bench the seat as a chain would", async (_label, text) => {
    const { served } = liveSeats({ replies: { openai: text }, labels: { openai: "OpenAI" } });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const ctx = { providerManager: m } as any;

    const reviewers: Array<string | undefined> = [];
    const checks: Array<Awaited<ReturnType<typeof consensusOn>>> = [];
    for (let check = 0; check < 3; check += 1) {
      const reviewer = resolveConsensusReviewAssignment(ctx, executor, executor, "chat:web:1");
      reviewers.push(reviewer?.providerName);
      checks.push(await consensusOn(executor, reviewer));
    }

    expect(checks.map((c) => c.verdict)).toEqual([undefined, undefined, undefined]);
    expect(checks.flatMap((c) => c.outcomes)).toEqual([
      { providerName: "openai", status: "failed" },
      { providerName: "openai", status: "failed" },
    ]);
    // The empty answer still cost tokens, booked to the seat that spent them.
    expect(checks[0]!.usages).toEqual([expect.objectContaining({ provider: "openai", inputTokens: 10, outputTokens: 5 })]);
    expect(served).toEqual(["openai", "openai"]);
    expect(reviewers).toEqual(["openai", "openai", undefined]);
    expect(ProviderHealthRegistry.getInstance().isAvailable("openai")).toBe(false);
  });
});

describe("the reviewer's spend is booked to the seat that served it", () => {
  it("a bare reviewer named by its display label is booked under its canonical seat, which the cost table knows", async () => {
    liveSeats({ labels: { openai: "OpenAI" } });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const reviewer = resolveConsensusReviewAssignment({ providerManager: m } as any, executor, executor, "chat:web:1");
    expect(reviewer?.provider.name).toBe("OpenAI");

    const { usages } = await consensusOn(executor, reviewer);

    expect(usages).toEqual([expect.objectContaining({ provider: "openai", inputTokens: 10, outputTokens: 5 })]);
  });

  it("a chain's servedBy stamp still names the member that answered (guard)", async () => {
    liveSeats({ atCall: ["openai"], labels: { openai: "OpenAI" } });
    const m = manager(["anthropic", "openai"], true);
    const executor = executorOf(m);
    const chained: SupervisorAssignment = {
      role: "reviewer",
      providerName: "openai",
      provider: m.getProviderByName("openai")!,
      reason: "a chain, as getProviderByName builds it",
    };

    const { usages } = await consensusOn(executor, chained);

    // The chain fell over to the member it names "anthropic"; that stamp is the booking.
    expect(usages.map((u) => u.provider)).toEqual(["anthropic"]);
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

  it("an openai that cannot be built bare is not the verifier: the chain of the seats that remain answered under its name", async () => {
    const { served } = liveSeats({ atBuild: ["openai"] });
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], true));
    const verdict = await verify(node("claude"), { chatId: "chat:web:1" } as any);

    expect(verdict.verifierProvider).not.toBe("openai");
    expect(verdict.independent).toBe(false);
    expect(seatsOf(served)).toEqual(["claude"]);
  });

  it("the worker's own seat that cannot be built bare does not review under its name", async () => {
    const { served } = liveSeats({ atBuild: ["claude"] });
    ProviderHealthRegistry.getInstance().recordCredentialRejected("openai", "401 invalid key");
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], true));
    const verdict = await verify(node("claude"), { chatId: "chat:web:1" } as any);

    expect(served).toEqual([]);
    expect(verdict).toMatchObject({ verdict: "skipped", unanswered: "no-healthy-verifier" });
  });

  it("a verifier that fails at call time is benched, so the next node is not sent to it", async () => {
    const { served } = liveSeats({ atCall: ["openai"], labels: { openai: "OpenAI" } });
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], true));

    const first = await verify(node("claude"), { chatId: "chat:web:1" } as any);
    await verify(node("claude"), { chatId: "chat:web:1" } as any);

    expect(first).toMatchObject({ verdict: "skipped", unanswered: "threw", verifierProvider: "openai" });
    expect(served.filter((name) => name === "openai")).toEqual(["openai"]);
    expect(ProviderHealthRegistry.getInstance().isAvailable("openai")).toBe(false);
  });

  it("a verifier that answers with nothing is benched after repeated empties, as a chain benches its member", async () => {
    const { served } = liveSeats({ replies: { openai: "" }, labels: { openai: "OpenAI" } });
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], true));

    const verdicts = [];
    for (let n = 0; n < 3; n += 1) verdicts.push(await verify(node("claude"), { chatId: "chat:web:1" } as any));

    expect(verdicts[0]).toMatchObject({ verdict: "skipped", unanswered: "empty", verifierProvider: "openai" });
    expect(served.filter((name) => name === "openai")).toEqual(["openai", "openai"]);
    expect(ProviderHealthRegistry.getInstance().isAvailable("openai")).toBe(false);
  });

  it("an independent verifier's 503 earns the chain's bench; the only seat reviewing itself keeps the short one", async () => {
    liveSeats({ atCall: ["openai", "claude"], labels: { openai: "OpenAI" } });
    const before = Date.now();

    await createSupervisorNodeVerifier(manager(["anthropic", "openai"], true))(node("claude"), { chatId: "chat:web:1" } as any);
    const independentBench = ProviderHealthRegistry.getInstance().getEntry("openai")!.cooldownUntil - before;
    ProviderHealthRegistry.resetInstance();
    const lone = await createSupervisorNodeVerifier(manager(["anthropic"], true))(node("claude"), { chatId: "chat:web:1" } as any);

    expect(independentBench).toBeGreaterThanOrEqual(5 * 60_000);
    expect(lone.independent).toBe(false);
    // A seat with nobody beside it gets the 30s single-provider bench (guard).
    expect(ProviderHealthRegistry.getInstance().getEntry("claude")!.cooldownUntil - before).toBeLessThanOrEqual(60_000);
  });

  it("an openai node on the same chain is verified by the Claude seat", async () => {
    const verify = createSupervisorNodeVerifier(manager(["anthropic", "openai"], true));
    const verdict = await verify(node("openai"), { chatId: "chat:web:1" } as any);

    expect(providerRecordKey(verdict.verifierProvider)).toBe("claude");
    expect(verdict.independent).toBeUndefined();
  });
});
