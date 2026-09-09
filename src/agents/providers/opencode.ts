import type { ProviderCapabilities } from "./provider.interface.js";
import { randomUUID } from "node:crypto";
import { OpenAIProvider } from "./openai.js";

/**
 * OpenCode hosted-platform base URLs (both OpenAI-compatible). The Go API lives
 * UNDER the zen path — opencode.ai/zen/go/v1 — NOT opencode.ai/go (a marketing
 * page; opencode.ai/go/v1 returns an HTML 404). Verified live via GET /models.
 *
 * Mirrored in the web portal at web-portal/src/types/setup-constants.ts
 * (OPENCODE_PLATFORM_BASE_URLS) — separate package, no shared import, keep in sync.
 */
export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * OpenCode (Zen/Go) provider.
 *
 * OpenCode Zen/Go provides curated coding models through an OpenAI-compatible API.
 * A single API key grants access to all Zen/Go models regardless of subscription tier.
 *
 * Base URLs: Zen = https://opencode.ai/zen/v1 (default), Go = https://opencode.ai/zen/go/v1.
 *
 * IMPORTANT — model id format: the API expects BARE ids (NO "opencode/" namespace).
 * The constructor strips a leading "opencode/" defensively because presets / saved
 * preferences / the model catalog historically used the namespaced form, which the API
 * now rejects ("ModelError: Model opencode/... is not supported"). Verified live via
 * GET /models. Model ids that are no longer offered must not be reintroduced.
 *
 * Current model ids (bare), from GET /models:
 * - Coding/general: qwen3.6-plus (default), qwen3.5-plus, deepseek-v4-flash, glm-5.1, glm-5
 * - OpenAI: gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.2-codex, ...
 * - Anthropic: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5, ...
 * - Others: gemini-3.5-flash, kimi-k2.6, kimi-k2.5, minimax-m2.7, minimax-m2.5
 *
 * @see https://opencode.ai/zen
 * @see https://opencode.ai/go
 */
/**
 * OPENCODE_FIRST_RESPONSE_TIMEOUT_MS, when it is a usable number.
 *
 * A malformed value returns undefined so the measured default stands: an env
 * typo must not silently disable the protection or shrink it to nothing.
 */
function readTimeoutOverride(): number | undefined {
  const raw = process.env["OPENCODE_FIRST_RESPONSE_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Output budget per call. Measured 2026-09-07 19:54 → 2026-09-08 03:24 on
 * nemotron-3.5-lightning-free: of 25 long streaming calls (goal
 * decompositions), 9 stopped at exactly 8192 with no answer, while the
 * successes finished at 7847, 7988, 7435, 6009 and 4631 output tokens — the
 * model mirrors its reasoning into the content stream and answers only after
 * it, so a budget of 8192 was the difference between a 7-node plan and three
 * wasted 200 s attempts. The endpoint accepted max_tokens 16384 and 32768
 * (200, finish_reason "stop"); 16384 doubles the headroom without letting a
 * genuine ramble run for a quarter of an hour. OPENCODE_MAX_TOKENS overrides.
 */
export const OPENCODE_MAX_TOKENS: number = (() => {
  // Floor BEFORE the positivity check: "0.5" passed `raw > 0` and floored to
  // max_tokens 0 (Codex review 2026-09-09). Anything below 1 token is not an override.
  const raw = Math.floor(Number(process.env["OPENCODE_MAX_TOKENS"]));
  return Number.isFinite(raw) && raw >= 1 ? raw : 16_384;
})();

/**
 * The context window the compaction pipeline plans against. The endpoint
 * advertises 128k, but measured 2026-09-09 the free tier stopped answering a
 * 57k-token turn (two 600 s zero-output calls) after serving 41-47k turns in
 * under a minute — so the window that matters is the one the model still
 * answers within, and it is configurable. Floor 8192; unset = 128k.
 */
export const OPENCODE_CONTEXT_WINDOW: number = (() => {
  const raw = Math.floor(Number(process.env["OPENCODE_CONTEXT_WINDOW"]));
  return Number.isFinite(raw) && raw >= 8_192 ? raw : 128_000;
})();

export class OpencodeProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: OPENCODE_MAX_TOKENS,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: OPENCODE_CONTEXT_WINDOW,
    thinkingSupported: false,
    // Measured 2026-08-21 against opencode.ai/zen/go with deepseek-v4-flash on
    // a goal-decomposition prompt: default effort spent 1595 reasoning chunks
    // before answering, "low" 876, "minimal" 497 — and minimal returned MORE
    // answer (1623 characters) than low (1285). The model always gets there;
    // the cost of thinking longer is latency, and latency is what a streaming
    // stall timeout measures. OPENCODE_REASONING_EFFORT overrides it for a
    // model or a workload that wants the deliberation.
    reasoningEffort:
      (process.env["OPENCODE_REASONING_EFFORT"] as ProviderCapabilities["reasoningEffort"]) ?? "low",
    // Zen/Go's free tier queues, and the wait is the queue rather than a fault.
    // Measured 2026-08-23 against ox-alpha-free with an identical three-word
    // prompt, five times: first byte at 4.1s, 11.9s, 26.3s, 64s and 70s. The
    // chain's 90s budget is the right shape — it is disarmed permanently by the
    // first chunk, so this buys patience before the answer starts and costs
    // nothing once it does — but the wrong size here, and two runs died at 90s
    // on a request carrying far more prefill than three words.
    //
    // 300s is a queue-spike allowance, not a licence to hang: a genuinely dead
    // endpoint still fails over, five minutes later instead of ninety seconds.
    // Set OPENCODE_FIRST_RESPONSE_TIMEOUT_MS to trade that patience back for
    // faster failover on a paid model that answers in seconds.
    firstResponseTimeoutMs: readTimeoutOverride() ?? 300_000,
    specialFeatures: ["coding", "function_calling", "json_mode"],
  };

  constructor(
    apiKey: string,
    model = "qwen3.6-plus",
    baseUrl = OPENCODE_ZEN_BASE_URL,
    /**
     * Registry name of THIS instance ("opencode", "opencode2", …). Provider
     * health, cooldowns and routing all key on `provider.name`, so a
     * hardcoded label collapsed every account into one entry — measured
     * 2026-08-31: account #1's 8h quota cooldown suppressed the two fresh
     * accounts that shared the label, and the chain reported a full outage
     * while two working accounts sat idle.
     */
    label = "OpenCode (Zen/Go)",
  ) {
    super(apiKey, OpencodeProvider.toBareModelId(model), baseUrl, label);
  }

  /**
   * OpenCode's API rejects namespaced model ids, so strip a leading "opencode/" — a
   * preset/preference/catalog value like "opencode/deepseek-v4-flash" becomes the bare
   * "deepseek-v4-flash" the API accepts. (Verified live via GET /models.)
   */
  private static toBareModelId(model: string): string {
    return model.startsWith("opencode/") ? model.slice("opencode/".length) : model;
  }

  /**
   * Build HTTP headers for OpenCode API requests.
   * Adds a User-Agent header identifying Strada.Brain.
   */
  protected override async buildHeaders(): Promise<Record<string, string>> {
    const headers = await super.buildHeaders();
    return {
      ...headers,
      "User-Agent": "Strada.Brain/1.0",
      // Measured 2026-09-07 07:39: every OpenCode call answered 400
      // MissingSessionID — "Request is missing x-opencode-session and cannot
      // be routed efficiently". One id per provider instance, as the codex
      // session id is kept.
      "x-opencode-session": this.opencodeSessionId,
    };
  }

  /** Stable for the life of this provider instance; differs across instances. */
  private readonly opencodeSessionId = randomUUID();

  // parseResponse is inherited from OpenAIProvider and works correctly
  // for OpenCode's OpenAI-compatible API. Override here if OpenCode adds
  // provider-specific response fields in the future.
}
