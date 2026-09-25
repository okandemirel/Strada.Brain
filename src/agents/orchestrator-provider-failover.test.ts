/**
 * N-1 — a soft `/model` preference must fail over within the turn.
 *
 * Found by the CLI release smoke: with PROVIDER_CHAIN=kimi,qwen and `/model kimi` (a SOFT
 * preference — "Strada will bias routing toward kimi"), a primary answering HTTP 503 blocked the
 * task as provider_unavailable while the healthy fallback received nothing; only the mission
 * keep-alive's retry 30 s later reached it. The turn's provider was materialized BARE because the
 * strategy used one provider for every role (`usesMultipleProviders: false`), which the
 * orchestrator read as a hard pin.
 *
 * Everything below the HTTP boundary is real: ProviderManager, the FallbackChain, the Kimi and
 * Qwen adapters, fetchWithRetry, the v2 worker run. Only `fetch` is faked (no network).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));
vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

const { Orchestrator } = await import("./orchestrator.js");
const { ProviderManager } = await import("./providers/provider-manager.js");
const { buildProviderChain } = await import("./providers/provider-registry.js");
const { ProviderHealthRegistry } = await import("./providers/provider-health.js");
const { selectAgentRunner, toWorkerRunResult } = await import("../agent-core/runner/index.js");
type RunnerHostOrchestrator = import("../agent-core/runner/index.js").RunnerHostOrchestrator;
type AgentRunRequest = import("../agent-core/runner/index.js").AgentRunRequest;

const ANSWER = "provider fallback ok";
const KIMI_HOST = "api.kimi.com";
const QWEN_HOST = "dashscope-intl.aliyuncs.com";
const CREDENTIALS = { kimi: { apiKey: "test-kimi-key" }, qwen: { apiKey: "test-qwen-key" } };

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function completion(text: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "qwen-max",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** The completion as an OpenAI-compatible SSE stream (what chatStream parses). */
function sse(text: string): Response {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "qwen-max", choices, ...extra })}\n\n`;
  const body =
    chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
    chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Kimi answers every chat call with a sustained 503 (a near-zero Retry-After keeps its own
 * status-retry budget fast); Qwen answers. Counts the calls per host.
 */
function installFakeProviders(): { kimi: number; qwen: number } {
  const calls = { kimi: 0, qwen: 0 };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/chat/completions")) {
      throw new Error(`unexpected request in test: ${url}`);
    }
    if (url.includes(KIMI_HOST)) {
      calls.kimi++;
      return new Response(
        JSON.stringify({ error: { message: "primary provider unavailable", type: "server_error" } }),
        { status: 503, headers: { "content-type": "application/json", "retry-after": "0.001" } },
      );
    }
    if (url.includes(QWEN_HOST)) {
      calls.qwen++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      return body.stream === true
        ? sse(ANSWER)
        : new Response(JSON.stringify(completion(ANSWER)), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected host in test: ${url}`);
  });
  return calls;
}

function harness() {
  const prefsDir = mkdtempSync(join(tmpdir(), "strada-failover-prefs-"));
  const projectPath = mkdtempSync(join(tmpdir(), "strada-failover-project-"));
  tempDirs.push(prefsDir, projectPath);
  mkdirSync(join(projectPath, "Assets"), { recursive: true });
  const order = ["kimi", "qwen"];
  const providerManager = new ProviderManager(
    buildProviderChain(order, CREDENTIALS),
    CREDENTIALS,
    undefined,
    prefsDir,
    order,
  );
  const orchestrator = new Orchestrator({
    providerManager,
    tools: [],
    channel: {
      name: "cli",
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: vi.fn(),
      sendText: vi.fn(),
      sendMarkdown: vi.fn(),
      isHealthy: () => true,
    },
    projectPath,
    readOnly: true,
    requireConfirmation: false,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  return { providerManager, orchestrator };
}

/** One background task run on the v2 route, exactly as the BackgroundExecutor starts it. */
async function runTask(orchestrator: InstanceType<typeof Orchestrator>, chatId: string, signal: AbortSignal) {
  const runner = selectAgentRunner(orchestrator as unknown as RunnerHostOrchestrator, "worker");
  const result = await runner.run(
    { prompt: "Run the provider fallback check and reply.", workerMode: "background", chatId, channelType: "cli" } as AgentRunRequest,
    { mode: "worker", onEvent: () => {}, externalSignal: signal, deliverFinal: () => {} },
  );
  return toWorkerRunResult(result);
}

describe("provider failover within one task turn (N-1)", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    ProviderHealthRegistry.clearFailureLog();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ProviderHealthRegistry.resetInstance();
  });

  it("a SOFT preference for a provider answering 503 is served by the healthy sibling in the same turn", async () => {
    const calls = installFakeProviders();
    const { providerManager, orchestrator } = harness();
    const chatId = "cli-soft-preference";
    // What `/model kimi` records: a bias, not a pin.
    providerManager.setPreference(chatId, "kimi");
    expect(providerManager.getActiveInfo(chatId).selectionMode).toBe("strada-preference-bias");

    const started = Date.now();
    // Well inside the smoke's 30 s window; the old code blocked here after its backoffs.
    const result = await runTask(orchestrator, chatId, AbortSignal.timeout(8_000));

    expect(result.status).toBe("completed");
    expect(result.visibleResponse).toContain(ANSWER);
    expect(calls.kimi).toBeGreaterThan(0); // the preferred provider was asked first…
    expect(calls.qwen).toBeGreaterThan(0); // …and the fallback answered, in this run
    expect(Date.now() - started).toBeLessThan(8_000);
    await orchestrator.dispose?.();
  }, 15_000);

  it("a HARD pin still stays on its provider: the sibling is never called", async () => {
    const calls = installFakeProviders();
    const { providerManager, orchestrator } = harness();
    const chatId = "cli-hard-pin";
    providerManager.setPreference(chatId, "kimi", undefined, "strada-hard-pin");

    // Long enough for several failed turns on the pinned provider, short of the ledger's
    // later backoffs; whatever the run's terminal, it must not have left the pin.
    const result = await runTask(orchestrator, chatId, AbortSignal.timeout(3_000));

    expect(calls.kimi).toBeGreaterThan(0);
    expect(calls.qwen).toBe(0);
    expect(result.visibleResponse).not.toContain(ANSWER);
    await orchestrator.dispose?.();
  }, 15_000);
});
