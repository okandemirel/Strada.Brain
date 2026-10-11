/**
 * providers#1, the orchestrator's half.
 *
 * `/model pin opencode/<model the gateway does not serve>` (or the web picker's
 * hardPin) hands the chat a bare seat named "opencode" — the same health key
 * as the default chain's member. OpenCode/Zen answers an unserved model with
 * `API error 401: … ModelError …`. The chain had stopped benching a seat for
 * that; the orchestrator's own classifier had not, so both of its paths — the
 * streaming refusal and the non-streaming call — put the seat on the 8h
 * credential bench, persisted, and every other chat lost it on every model.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { Session } from "./orchestrator-session-manager.js";
import { ProviderHealthRegistry } from "./providers/provider-health.js";
import { openRunClock, type RunClock } from "../agent-core/control/run-clock.js";
import { FakeClock } from "../agent-core/control/clock.js";
import { createMockChannel, createMockProvider } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

beforeEach(() => {
  ProviderHealthRegistry.resetInstance();
});

const MODEL_ERROR =
  'OpenCode (Zen/Go) API error 401: {"type":"error","error":{"type":"ModelError","message":"Model stale-model-xyz is not supported"}}';
const KEY_ERROR = "OpenCode (Zen/Go) API error 401: invalid api key";

function orchestrator() {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: createMockChannel() as never,
    projectPath: "/tmp/hard-pinned-model-rejection-test",
    readOnly: false,
    requireConfirmation: false,
  });
}

/** The bare seat a hard pin builds: not a chain, so the orchestrator's classifier is the only one. */
function pinnedSeat(message: string) {
  return {
    name: "opencode",
    capabilities: {
      maxTokens: 4096, streaming: true, toolCalling: true, vision: false, systemPrompt: true, thinkingSupported: false,
    },
    chat: vi.fn().mockRejectedValue(new Error(message)),
    chatStream: vi.fn().mockRejectedValue(new Error(message)),
  };
}

function session(): Session {
  return { messages: [{ role: "user", content: "hi" }], visibleMessages: [], lastActivity: new Date() };
}

type SilentStream = (
  chatId: string, systemPrompt: string, s: Session, p: unknown, tools: unknown[],
  externalSignal?: AbortSignal, onLiveness?: () => void, runClock?: RunClock,
) => Promise<unknown>;
type Fallback = (p: unknown, prompt: string, s: Session, tools: unknown[], signal: undefined, chatId: string) => Promise<unknown>;

function runClock(): RunClock {
  return openRunClock(new FakeClock(0), {
    mode: "background",
    taskHardMs: Number.POSITIVE_INFINITY,
    taskInactivityMs: 600_000,
    callFirstResponseMs: 600_000,
    callStallMs: 600_000,
    callHardMs: 600_000,
    outputTokenCap: 100_000,
    costCapUsd: 10,
  });
}

function seatHealth() {
  const health = ProviderHealthRegistry.getInstance();
  return { available: health.isAvailable("opencode"), cooldownUntil: health.getEntry("opencode")?.cooldownUntil ?? 0 };
}

describe("a hard-pinned seat whose gateway rejects the model", () => {
  it("non-streaming call: the seat keeps its health", async () => {
    const orch = orchestrator();
    const fallback = (orch as unknown as { silentStreamFallback: Fallback }).silentStreamFallback.bind(orch);

    await fallback(pinnedSeat(MODEL_ERROR), "system", session(), [], undefined, "chat-pinned");

    expect(seatHealth()).toEqual({ available: true, cooldownUntil: 0 });
    orch.dispose();
  });

  it("streaming refusal: the seat keeps its health", async () => {
    const orch = orchestrator();
    const stream = (orch as unknown as { silentStream: SilentStream }).silentStream;

    await expect(
      stream("chat-pinned", "system", session(), pinnedSeat(MODEL_ERROR), [], undefined, undefined, runClock()),
    ).rejects.toThrow(/ModelError/);

    expect(seatHealth()).toEqual({ available: true, cooldownUntil: 0 });
    orch.dispose();
  });

  it("a key the gateway refuses is still benched on both paths", async () => {
    const orch = orchestrator();
    const fallback = (orch as unknown as { silentStreamFallback: Fallback }).silentStreamFallback.bind(orch);
    await fallback(pinnedSeat(KEY_ERROR), "system", session(), [], undefined, "chat-pinned");
    expect(seatHealth().available).toBe(false);

    ProviderHealthRegistry.resetInstance();
    const stream = (orch as unknown as { silentStream: SilentStream }).silentStream;
    await expect(
      stream("chat-pinned", "system", session(), pinnedSeat(KEY_ERROR), [], undefined, undefined, runClock()),
    ).rejects.toThrow(/401/);
    expect(seatHealth().available).toBe(false);
    orch.dispose();
  });
});
