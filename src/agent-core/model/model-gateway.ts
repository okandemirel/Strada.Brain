/**
 * Agent Core v2 — ModelGateway: the SINGLE LLM entry point (ARCHITECTURE §5.2, §4.4, §10.2).
 *
 * Replaces silentStream as the ONLY way the agent core calls an LLM — v1's two call sites
 * (interactive runAgentLoop, background runBackgroundTask) collapse to one. Imports and CALLS
 * the frozen `silentStream` through a narrow port; it does NOT reimplement its body.
 *
 * Boundaries (what it does NOT do):
 *  - does NOT pick providers (FallbackChain is KEPT and owns that — the caller hands in the
 *    already-selected provider),
 *  - does NOT know what a channel is (channel-awareness lives in SINKS, never the gateway),
 *  - streaming-default gated on supportsStreaming(provider).
 *
 * THE INVERSION OF v1: where silentStream's onChunk does ONE thing (drive the watchdog, DISCARD
 * the text), the gateway does TWO — the watchdog drive STAYS INSIDE the frozen silentStream
 * (unchanged), and the gateway TEES the same chunk into the bus as model.delta / heartbeat. The
 * frozen silentStream finally surfaces the token deltas v1 discarded.
 *
 * THE ONE SUBTLETY (must not get wrong): in the SHIPPED Phase-1b code, CallScope.touch() /
 * firstTokenSeen() are already called INSIDE silentStream (flag-ON branch). So the division of
 * labor is: silentStream owns watchdog/touch (frozen); the gateway owns emit (new). The gateway
 * MUST NOT re-call touch()/firstTokenSeen() (that would double-arm the inactivity timer).
 *
 * PURELY ADDITIVE: silentStream is UNCHANGED. nothing in v1 imports this yet (Phase 2). When no
 * chunk observer is wired (the additive `onChunkObserver?` refactor has not landed), deltas are
 * derived from the final response (no per-token UI) — byte-identical v1 behavior preserved.
 */

import type { ProviderResponse, TokenUsage } from "../../agents/providers/provider-core.interface.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import { supportsStreaming } from "../../agents/providers/provider.interface.js";
import { isEmptyProviderResponse } from "../../agents/orchestrator-runtime-utils.js";
import type { JsonObject } from "../../types/index.js";
import type { AgentRunEventBus } from "../events/event-bus.js";

/**
 * Opaque interactive session handle. Typed `unknown` to keep agent-core free of a concrete
 * `Session` import (no cycle) — the same indirection runner/agent-runner.ts uses. The port's
 * caller (the Orchestrator) supplies its own real `Session`.
 */
export type SessionLike = unknown;

/** The tool-definition shape the frozen silentStream accepts (matched verbatim). */
export type GatewayToolDefinition = {
  name: string;
  description: string;
  input_schema: JsonObject;
};

export interface ModelCallRequest {
  readonly chatId: string;
  readonly systemPrompt: string;
  readonly session: SessionLike;
  /** The provider already selected by FallbackChain (gateway does NOT route). */
  readonly provider: IAIProvider;
  readonly toolDefinitions: GatewayToolDefinition[];
  /** Dual-signal abort preserved VERBATIM: externalSignal = task token (§2.2). */
  readonly externalSignal?: AbortSignal;
}

export interface ModelCallResult {
  readonly response: ProviderResponse;
  /** Computed ONCE here (§5.2) — breaker + registry read this flag, never re-infer. */
  readonly empty: boolean;
  readonly streamed: boolean;
}

/**
 * The frozen silentStream, narrowed to a PORT — matches the SHIPPED signature exactly:
 * (chatId, systemPrompt, session, provider, toolDefinitions, externalSignal?, onLiveness?,
 *  runClock?). The Orchestrator supplies its own bound `silentStream` method here, with NO body
 * change. The gateway uses the `onLiveness` slot (7th) for task-scope liveness; the `runClock`
 * slot (8th) stays the loop's concern and is passed `undefined` (the gateway does not own the
 * RunClock-touch surface — silentStream does).
 *
 * `runClock` is typed `unknown` so this port carries no dependency on the control-plane RunClock
 * concrete (the Orchestrator's real method narrows it back).
 */
export type SilentStreamPort = (
  chatId: string,
  systemPrompt: string,
  session: SessionLike,
  provider: IAIProvider,
  toolDefinitions: GatewayToolDefinition[],
  externalSignal: AbortSignal | undefined,
  onLiveness: (() => void) | undefined,
  runClock: unknown,
) => Promise<ProviderResponse>;

/**
 * The chunk-tee port. The frozen silentStream calls THIS for every chunk once the additive
 * `onChunkObserver?` refactor lands (it would invoke `onChunkObserver?.(chunk)` INSIDE its
 * existing onChunk — zero logic change). The gateway owns WHAT the observer does (emit +
 * Phase-5 capture). Until that refactor lands the observer is simply never invoked and the
 * gateway falls back to deriving the delta from the final response.
 */
export type ChunkObserver = (chunk: string) => void;

/**
 * Phase-5 visible-token capture port. The gateway captures the non-empty answer delta here so
 * Phase 5 can forward it to the IOStrategy.visibleSink — but the EDGE TO THE WEB SINK STAYS OFF
 * (silent streaming bypasses the visible sink today by design). Injecting this is the capture
 * point; it is undefined (gated OFF) in Phase 2.
 */
export type VisibleAnswerCapture = (text: string) => void;

export interface ModelGatewayOptions {
  /**
   * Optional: a refactor exposing silentStream's chunk tee. Given the gateway's chunk observer,
   * it returns a SilentStreamPort wired to invoke that observer per chunk. When absent, deltas
   * are derived from the final response (preserving byte-identical v1 behavior).
   */
  readonly attachChunkObserver?: (observer: ChunkObserver) => SilentStreamPort;
  /**
   * Phase-5 capture sink for the non-empty answer delta. GATED OFF in Phase 2 (undefined): the
   * capture happens but is not forwarded to any channel. Present so the seam is stable.
   */
  readonly visibleAnswerCapture?: VisibleAnswerCapture;
}

export class ModelGateway {
  private readonly attachChunkObserver?: (observer: ChunkObserver) => SilentStreamPort;
  private readonly visibleAnswerCapture?: VisibleAnswerCapture;

  constructor(
    private readonly silentStream: SilentStreamPort,
    options: ModelGatewayOptions = {},
  ) {
    this.attachChunkObserver = options.attachChunkObserver;
    this.visibleAnswerCapture = options.visibleAnswerCapture;
  }

  /**
   * THE one entry. Drives the watchdog (inside frozen silentStream) AND emits typed deltas.
   * Streaming-default gate; on a non-stream provider silentStream's own non-stream path runs.
   */
  async call(req: ModelCallRequest, bus: AgentRunEventBus): Promise<ModelCallResult> {
    const streamed = supportsStreaming(req.provider);
    // `model` is NOT on the IAIProvider interface (the assigned model name lives in the
    // provider-info metadata FallbackChain threads). Read it defensively for the event label
    // when a concrete provider happens to expose it; otherwise leave the optional field unset.
    const model = (req.provider as { readonly model?: string }).model;
    bus.emit({
      type: "model.call.started",
      // `name` is a required string, but a concrete provider may surface it blank; fall back to
      // "unknown" for any falsy value (empty included) so the event label is never an empty tag.
      provider: req.provider.name || "unknown",
      model,
      streaming: streamed,
    });

    // ── The per-chunk routing table (§5.2). touch()/firstTokenSeen() are ALREADY called inside
    //    the frozen silentStream; here we ONLY emit + (Phase 5) capture for visibleSink. ──
    const observe: ChunkObserver = (chunk: string) => {
      if (chunk) {
        // Visible text → model.delta channel:"answer" (the only content channel). The frozen
        // silentStream already called scope.firstTokenSeen()+touch(); we do NOT repeat them.
        bus.emit({ type: "model.delta", channel: "answer", text: chunk });
        // PHASE 5 (gated OFF here): capture for the IOStrategy.visibleSink. The edge to
        // channel.updateStreamingMessage stays OFF — silent streaming bypasses the sink today
        // by design. This is exactly the capture point Phase 5 wires.
        this.visibleAnswerCapture?.(chunk);
      } else {
        // Empty keepalive / reasoning-summary delta. silentStream already drove markAlive() /
        // its onLiveness throttle; we emit the first-class heartbeat so the watchdog and the
        // "is content" check never collide.
        bus.emit({ type: "heartbeat", source: "model-keepalive" });
      }
    };

    // Wire the tee if the Orchestrator exposed the observer hook; else call frozen as-is. Either
    // way silentStream's body is UNTOUCHED — the hook (when present) is a pure additive tee.
    const stream = this.attachChunkObserver ? this.attachChunkObserver(observe) : this.silentStream;

    // onLiveness: the throttled task-inactivity re-arm. The gateway forwards it as a heartbeat
    // emission too (the empty-chunk path also emits; onLiveness is the task-scope pulse).
    const onLiveness = () => bus.emit({ type: "heartbeat", source: "model-keepalive" });

    const response = await stream(
      req.chatId,
      req.systemPrompt,
      req.session,
      req.provider,
      req.toolDefinitions,
      req.externalSignal, // dual-signal preserved verbatim
      onLiveness,
      undefined, // runClock slot stays the loop's concern; the gateway does not own the touch surface
    );

    // No chunk observer wired → derive the visible answer-delta from the final response so the
    // typed stream still carries the content (no per-token granularity, but never silent). This
    // is the byte-identical-v1 fallback; gated capture still runs for Phase 5 readiness.
    if (!this.attachChunkObserver && response.text) {
      bus.emit({ type: "model.delta", channel: "answer", text: response.text });
      this.visibleAnswerCapture?.(response.text);
    }

    // Compute empty ONCE (§5.2) — single flag for breaker + registry; never re-infer.
    const empty = isEmptyProviderResponse(response);
    bus.emit({
      type: "model.call.finished",
      stopReason: response.stopReason,
      empty,
      usage: response.usage as TokenUsage,
    });

    return { response, empty, streamed };
  }
}
