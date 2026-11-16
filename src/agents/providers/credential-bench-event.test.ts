import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProviderHealthRegistry, type CredentialBenchEvent } from "./provider-health.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { recordProviderHealthFailure } from "../orchestrator-runtime-utils.js";
import { buildProviderBenchNotice } from "../../tasks/provider-bench-notice.js";
import type { IAIProvider, ProviderResponse } from "./provider.interface.js";

vi.mock("../../utils/logger.js", () => {
  const spies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => spies, getLoggerSafe: () => spies };
});

const HOUR_MS = 60 * 60 * 1000;

describe("ProviderHealthRegistry credential bench event", () => {
  let registry: ProviderHealthRegistry;
  let heard: CredentialBenchEvent[];

  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    registry = ProviderHealthRegistry.getInstance();
    heard = [];
    registry.onCredentialBench((e) => heard.push(e));
  });

  it("announces a refused key once, with the seat, the reason, the bench length and who carries on", () => {
    registry.recordCredentialRejected("alpha", "alpha API error 401: invalid api key\nsecond line", "beta");
    expect(heard).toEqual([
      { provider: "alpha", reason: "alpha API error 401: invalid api key", benchedForMs: 8 * HOUR_MS, continuingOn: "beta" },
    ]);
  });

  it("says nothing when the seat is already benched: the user is told once per session", () => {
    registry.recordCredentialRejected("alpha", "401", "beta");
    registry.recordCredentialRejected("alpha", "401 again", "beta");
    expect(heard).toHaveLength(1);
  });

  it("announces nothing for a cooldown that heals on its own", () => {
    registry.recordOverloadedShort("alpha", "503");
    registry.recordFailure("alpha", "overloaded 529");
    expect(heard).toEqual([]);
  });

  it("carries a known 'nobody left' as null, and masks secrets in the reason", () => {
    registry.recordCredentialRejected("alpha", "401 key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD rejected", null);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.continuingOn).toBeNull();
    expect(heard[0]!.reason).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("a listener that throws never stops the bench, and a later listener still hears it", () => {
    const unsubscribe = registry.onCredentialBench(() => { throw new Error("listener broke"); });
    const later = vi.fn();
    registry.onCredentialBench(later);
    registry.recordCredentialRejected("alpha", "401", "beta");
    expect(registry.isAvailable("alpha")).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops announcing to a listener that unsubscribed", () => {
    const quiet = vi.fn();
    registry.onCredentialBench(quiet)();
    registry.recordCredentialRejected("alpha", "401", "beta");
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("who carries on is never guessed", () => {
  let registry: ProviderHealthRegistry;
  let heard: CredentialBenchEvent[];

  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    registry = ProviderHealthRegistry.getInstance();
    heard = [];
    registry.onCredentialBench((e) => heard.push(e));
  });

  const answering = (name: string, behaviour: Error | string): IAIProvider => ({
    name,
    capabilities: {
      maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true,
      vision: false, systemPrompt: true, contextWindow: 8192,
    },
    chat: vi.fn(async (): Promise<ProviderResponse> => {
      if (behaviour instanceof Error) throw behaviour;
      return { text: behaviour, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } as ProviderResponse;
    }),
  }) as unknown as IAIProvider;

  it("liveSuccessor takes the next available seat after the refused one, then wraps, else null", () => {
    const chain = ["a", "b", "c"];
    expect(registry.liveSuccessor(chain, "b")).toBe("c");
    expect(registry.liveSuccessor(chain, "c")).toBe("a");
    registry.recordCredentialRejected("c", "401");
    expect(registry.liveSuccessor(chain, "b")).toBe("a");
    registry.recordCredentialRejected("a", "401");
    expect(registry.liveSuccessor(chain, "b")).toBeNull();
  });

  it("a recovery probe answered with 401 names the healthy sibling that carries on", async () => {
    const dead = answering("dead", new Error("HTTP 401: invalid_api_key"));
    const backup = answering("backup", "from-backup");
    // The seat was benched for quota; the bench has just expired, so the chain probes it.
    registry.recordQuotaExhausted("dead", "HTTP 403: quota exceeded");
    Object.assign(registry.getEntry("dead")!, { cooldownUntil: Date.now() - 1000 });
    await new FallbackChainProvider([dead, backup]).chat("sys", [], []);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ provider: "dead", continuingOn: "backup" });
  });

  it("a bare provider's 401 with a healthy sibling elsewhere never claims 'no other provider is left'", () => {
    expect(registry.isAvailable("kimi")).toBe(true);
    recordProviderHealthFailure(registry, "deepseek", "DeepSeek API error 401: invalid api key");
    expect(heard).toHaveLength(1);
    expect(heard[0]!.continuingOn).toBeUndefined();
    const { sentence, note } = buildProviderBenchNotice("Draft the report", heard[0]!);
    expect(sentence).not.toContain("no other provider");
    expect(sentence).not.toContain("continues on");
    expect(note).not.toContain("no other provider");
  });
});
