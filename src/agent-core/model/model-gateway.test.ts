/**
 * Agent Core v2 — ModelGateway unit tests (Phase 2 foundations).
 *
 * Verifies the gateway WRAPS (delegates to) a silentStream port and ADDS emit, without
 * reimplementing streaming:
 *  - delegates to the silentStream port with the dual-signal preserved verbatim,
 *  - emits model.call.started / model.call.finished around the call,
 *  - no-observer path: derives the answer delta from the final response,
 *  - observer path: emits a model.delta per non-empty chunk + a heartbeat per empty chunk,
 *  - never re-calls touch()/firstTokenSeen() (the gateway owns emit, NOT the watchdog),
 *  - computes `empty` ONCE via the shared predicate,
 *  - the Phase-5 visibleAnswerCapture is GATED OFF (only fires when explicitly injected).
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createAgentRunEventBus } from "../events/event-bus.js";
import { ModelGateway, type SilentStreamPort, type ChunkObserver } from "./model-gateway.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";

// ── helpers ───────────────────────────────────────────────────────────────

function mkProvider(overrides: Partial<IAIProvider> = {}): IAIProvider {
  return {
    name: "mock",
    model: "mock-model",
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
    // chatStream presence + capabilities.streaming → supportsStreaming(provider) === true
    chatStream: vi.fn(),
    ...overrides,
  } as IAIProvider;
}

function mkResponse(text: string, opts: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...opts,
  };
}

function mkRequest(provider: IAIProvider, externalSignal?: AbortSignal) {
  return {
    chatId: "chat-1",
    systemPrompt: "sys",
    session: { messages: [] } as unknown,
    provider,
    toolDefinitions: [],
    externalSignal,
  };
}

describe("ModelGateway — delegation", () => {
  it("calls the silentStream port with the request args + dual signal, returns its response", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const ext = new AbortController().signal;
    const expected = mkResponse("hello world");

    const port = vi.fn<SilentStreamPort>(async () => expected);
    const gw = new ModelGateway(port);

    const result = await gw.call(mkRequest(provider, ext), bus);

    expect(port).toHaveBeenCalledTimes(1);
    const args = port.mock.calls[0];
    expect(args[0]).toBe("chat-1"); // chatId
    expect(args[1]).toBe("sys"); // systemPrompt
    expect(args[3]).toBe(provider); // provider (caller-selected; gateway does not route)
    expect(args[5]).toBe(ext); // externalSignal preserved verbatim
    expect(typeof args[6]).toBe("function"); // onLiveness supplied
    expect(args[7]).toBeUndefined(); // runClock slot stays the loop's concern
    expect(result.response).toBe(expected);
    expect(result.streamed).toBe(true);
  });

  it("emits model.call.started then model.call.finished around the call", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const port: SilentStreamPort = async () => mkResponse("done", { stopReason: "end_turn" });
    const gw = new ModelGateway(port);

    await gw.call(mkRequest(provider), bus);

    const started = bus.log.find((e) => e.type === "model.call.started");
    const finished = bus.log.find((e) => e.type === "model.call.finished");
    expect(started).toMatchObject({ provider: "mock", model: "mock-model", streaming: true });
    expect(finished).toMatchObject({ stopReason: "end_turn", empty: false });
    // started precedes finished
    expect(started!.seq).toBeLessThan(finished!.seq);
  });

  it("reports streaming:false when the provider does not support streaming", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const nonStream = mkProvider({
      capabilities: {
        maxTokens: 4096,
        streaming: false,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
      },
      chatStream: undefined as never,
    });
    const port: SilentStreamPort = async () => mkResponse("x");
    const gw = new ModelGateway(port);
    await gw.call(mkRequest(nonStream), bus);
    expect(bus.log.find((e) => e.type === "model.call.started")).toMatchObject({ streaming: false });
  });

  it("falls back to provider name 'unknown' when name is empty", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider({ name: "" });
    const port: SilentStreamPort = async () => mkResponse("x");
    await new ModelGateway(port).call(mkRequest(provider), bus);
    expect(bus.log.find((e) => e.type === "model.call.started")).toMatchObject({ provider: "unknown" });
  });
});

describe("ModelGateway — no-observer path (byte-identical v1 fallback)", () => {
  it("derives ONE answer delta from the final response text", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const port: SilentStreamPort = async () => mkResponse("final answer");
    const gw = new ModelGateway(port); // no attachChunkObserver

    await gw.call(mkRequest(provider), bus);

    const deltas = bus.log.filter((e) => e.type === "model.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ channel: "answer", text: "final answer" });
  });

  it("emits NO delta when the final response text is empty", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const port: SilentStreamPort = async () => mkResponse("", { toolCalls: [] });
    await new ModelGateway(port).call(mkRequest(provider), bus);
    expect(bus.log.filter((e) => e.type === "model.delta")).toHaveLength(0);
  });
});

describe("ModelGateway — observer path", () => {
  it("emits a model.delta per non-empty chunk and a heartbeat per empty chunk", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();

    // The attachChunkObserver hook simulates the additive silentStream refactor: it feeds chunks
    // to the gateway's observer, exactly as the frozen onChunk's `onChunkObserver?.(chunk)` would.
    let captured: ChunkObserver | undefined;
    const attachChunkObserver = (observer: ChunkObserver): SilentStreamPort => {
      captured = observer;
      return async () => {
        // Simulate the stream: two visible chunks, one empty keepalive in between.
        observer("Hello ");
        observer(""); // keepalive / reasoning delta → heartbeat, NOT content
        observer("world");
        return mkResponse("Hello world");
      };
    };

    // The base port is unused when attachChunkObserver is present (the wired port replaces it).
    const basePort: SilentStreamPort = async () => mkResponse("");
    const gw = new ModelGateway(basePort, { attachChunkObserver });
    await gw.call(mkRequest(provider), bus);

    expect(captured).toBeTypeOf("function");
    const deltas = bus.log.filter((e) => e.type === "model.delta");
    const beats = bus.log.filter((e) => e.type === "heartbeat");
    expect(deltas.map((d) => (d.type === "model.delta" ? d.text : ""))).toEqual(["Hello ", "world"]);
    expect(deltas.every((d) => d.type === "model.delta" && d.channel === "answer")).toBe(true);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ source: "model-keepalive" });
    // No final-response-derived delta when the observer path is active (no double emission).
    expect(deltas).toHaveLength(2);
  });

  it("does NOT call provider.chatStream directly — only the port (delegation, not reimplementation)", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const port: SilentStreamPort = vi.fn(async () => mkResponse("x"));
    await new ModelGateway(port).call(mkRequest(provider), bus);
    expect(provider.chatStream).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
    expect(port).toHaveBeenCalledTimes(1);
  });
});

describe("ModelGateway — empty computed once", () => {
  it("marks empty:true for a no-text no-tool response and reflects it in the result", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const port: SilentStreamPort = async () => mkResponse("", { toolCalls: [], stopReason: "end_turn" });
    const result = await new ModelGateway(port).call(mkRequest(provider), bus);

    expect(result.empty).toBe(true);
    expect(bus.log.find((e) => e.type === "model.call.finished")).toMatchObject({ empty: true });
  });

  it("honors the explicit meta.empty signal", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    // Non-blank text but meta.empty:true → the shared predicate treats it as empty.
    const port: SilentStreamPort = async () => mkResponse("placeholder", { meta: { empty: true } });
    const result = await new ModelGateway(port).call(mkRequest(provider), bus);
    expect(result.empty).toBe(true);
  });
});

describe("ModelGateway — Phase-5 visibleSink capture is gated OFF", () => {
  it("does NOT invoke a capture by default (no sink injected)", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const port: SilentStreamPort = async () => mkResponse("visible text");
    // No visibleAnswerCapture passed → the capture seam is OFF.
    await new ModelGateway(port).call(mkRequest(provider), bus);
    // Sanity: the delta still landed on the bus (typed stream), it just was not forwarded anywhere.
    expect(bus.log.some((e) => e.type === "model.delta")).toBe(true);
  });

  it("invokes the capture ONLY when explicitly injected (proves the seam exists but is off by default)", async () => {
    const clock = new FakeClock();
    const bus = createAgentRunEventBus({ runId: "r", clock });
    const provider = mkProvider();
    const capture = vi.fn();
    const port: SilentStreamPort = async () => mkResponse("captured");
    await new ModelGateway(port, { visibleAnswerCapture: capture }).call(mkRequest(provider), bus);
    expect(capture).toHaveBeenCalledWith("captured");
  });
});
