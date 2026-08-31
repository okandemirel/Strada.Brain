import type { ProviderCapabilities } from "./provider.interface.js";
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

export class OpencodeProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 128_000,
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
    };
  }

  // parseResponse is inherited from OpenAIProvider and works correctly
  // for OpenCode's OpenAI-compatible API. Override here if OpenCode adds
  // provider-specific response fields in the future.
}
