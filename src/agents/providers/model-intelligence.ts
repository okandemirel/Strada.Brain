/**
 * Model Intelligence Service
 *
 * Self-updating model metadata service that fetches model information from
 * external sources (LiteLLM, models.dev), caches in SQLite, and provides
 * a hardcoded fallback registry for offline operation.
 *
 * Merge strategy: LiteLLM (primary) -> models.dev (enrichment) -> SQLite cache, with the
 * hardcoded static catalog laid over all of it: a model it declares is always the static
 * entry, and remote data only adds models it does not declare.
 * Refresh interval: 24h by default (configured by runtime config).
 */

import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import { getLogger } from "../../utils/logger.js";
import {
  DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH,
  extractProviderOfficialSignals,
  loadProviderSourceRegistry,
  type ProviderOfficialSnapshot,
  type ProviderOfficialSource,
} from "./provider-source-registry.js";
import type { ProviderCatalogHealth, RefreshResult } from "./provider-types.js";
import { releaseStreamReader } from "../../common/stream-reader.js";
import { providerRecordKey } from "./provider-identity.js";

// Re-export RefreshResult so existing consumers of this module are unaffected
export type { RefreshResult } from "./provider-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
  readonly supportsVision: boolean;
  readonly supportsThinking: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsStreaming: boolean;
  readonly lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Hardcoded fallback registry
// ---------------------------------------------------------------------------

function buildHardcoded(): Map<string, ModelInfo> {
  const now = Date.now();
  const entries: Array<Omit<ModelInfo, "lastUpdated">> = [
    // Anthropic model IDs are complete as published — never append a date
    // suffix to an alias. `claude-sonnet-4-6-20250514` and
    // `claude-opus-4-6-20250514` were such fabrications (20250514 is Claude
    // Opus 4's release date, pasted onto a 4.6 alias) and 404'd on every call.
    {
      id: "claude-opus-5",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 5,
      outputPricePerMillion: 25,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-sonnet-5",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-opus-4-8",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 5,
      outputPricePerMillion: 25,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-sonnet-4-6",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-opus-4-6",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 5,
      outputPricePerMillion: 25,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-haiku-4-5",
      provider: "claude",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      inputPricePerMillion: 1,
      outputPricePerMillion: 5,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "gpt-5.4",
      provider: "openai",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 15,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "gpt-5.2",
      provider: "openai",
      contextWindow: 128_000,
      maxOutputTokens: 128_000,
      inputPricePerMillion: 1.75,
      outputPricePerMillion: 14,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "gemini-3.1-pro-preview",
      provider: "gemini",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_000,
      inputPricePerMillion: 2,
      outputPricePerMillion: 12,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "gemini-3-flash-preview",
      provider: "gemini",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_000,
      inputPricePerMillion: 0.5,
      outputPricePerMillion: 3,
      supportsVision: true,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "deepseek-chat",
      provider: "deepseek",
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      inputPricePerMillion: 0.28,
      outputPricePerMillion: 0.42,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "kimi-for-coding",
      provider: "kimi",
      contextWindow: 262_000,
      maxOutputTokens: 65_000,
      inputPricePerMillion: 0.6,
      outputPricePerMillion: 2.5,
      supportsVision: false,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "MiniMax-M2.7",
      provider: "minimax",
      contextWindow: 204_800,
      maxOutputTokens: 131_072,
      inputPricePerMillion: 0.30,
      outputPricePerMillion: 1.20,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "MiniMax-M2.7-highspeed",
      provider: "minimax",
      contextWindow: 204_800,
      maxOutputTokens: 131_072,
      inputPricePerMillion: 0.30,
      outputPricePerMillion: 1.20,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "MiniMax-M2.5",
      provider: "minimax",
      contextWindow: 196_608,
      maxOutputTokens: 65_536,
      inputPricePerMillion: 0.12,
      outputPricePerMillion: 0.99,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "MiniMax-M2.5-highspeed",
      provider: "minimax",
      contextWindow: 196_608,
      maxOutputTokens: 65_536,
      inputPricePerMillion: 0.12,
      outputPricePerMillion: 0.99,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "qwen3.5-plus",
      provider: "qwen",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_000,
      inputPricePerMillion: 0.18,
      outputPricePerMillion: 1.56,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "mistral-large-3",
      provider: "mistral",
      contextWindow: 262_000,
      maxOutputTokens: 8_000,
      inputPricePerMillion: 0.5,
      outputPricePerMillion: 1.5,
      supportsVision: true,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "llama3.3",
      provider: "ollama",
      contextWindow: 8_000,
      maxOutputTokens: 4_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      supportsVision: false,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    // OpenCode (Zen/Go) catalog. Only the Zen DEFAULT is keyed BARE, because the
    // configured default (stored bare in OPENCODE_DEFAULT_MODEL) must resolve in
    // getModelInfo() to price correctly, and "qwen3.6-plus" is a Zen-specific id
    // absent from the live LiteLLM catalog. Every other entry keeps the "opencode/"
    // namespace: bare names like gpt-5.5 / claude-sonnet-4-6 / kimi-k2.6 also exist
    // in LiteLLM as native openai/anthropic/kimi rows, and the refresh merge keeps
    // the live row (adds hardcoded only `if (!this.models.has(id))`), so a bare key
    // would be shadowed and mis-attributed away from opencode. See opencode.ts.
    {
      id: "qwen3.6-plus",
      provider: "opencode",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      inputPricePerMillion: 0.60,
      outputPricePerMillion: 3.00,
      supportsVision: true,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "opencode/gpt-5.5",
      provider: "opencode",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      inputPricePerMillion: 1.75,
      outputPricePerMillion: 14.00,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "opencode/claude-sonnet-4-6",
      provider: "opencode",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      inputPricePerMillion: 3.00,
      outputPricePerMillion: 15.00,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "opencode/deepseek-v4-flash",
      provider: "opencode",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      inputPricePerMillion: 0.50,
      outputPricePerMillion: 2.00,
      supportsVision: false,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "opencode/glm-5.1",
      provider: "opencode",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      inputPricePerMillion: 0.30,
      outputPricePerMillion: 1.20,
      supportsVision: false,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "opencode/kimi-k2.6",
      provider: "opencode",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      inputPricePerMillion: 0.60,
      outputPricePerMillion: 3.00,
      supportsVision: false,
      supportsThinking: false,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
  ];

  const map = new Map<string, ModelInfo>();
  for (const entry of entries) {
    map.set(entry.id, { ...entry, lastUpdated: now });
  }
  return map;
}

export const HARDCODED_MODELS: Map<string, ModelInfo> = buildHardcoded();

// ---------------------------------------------------------------------------
// Provider name inference
// ---------------------------------------------------------------------------

/** Best-effort mapping from a model id to a canonical provider name. */
function inferProvider(modelId: string, originalKey?: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("gpt") || id.includes("o1") || id.includes("o3") || id.includes("o4")) return "openai";
  if (id.includes("gemini")) return "gemini";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("qwen")) return "qwen";
  if (id.includes("kimi") || id.includes("moonshot")) return "kimi";
  if (id.includes("mistral") || id.includes("codestral") || id.includes("pixtral")) return "mistral";
  // If the original key starts with "ollama/", preserve "ollama" as provider
  if (originalKey && originalKey.toLowerCase().startsWith("ollama/")) return "ollama";
  if (id.includes("llama")) return "meta";
  if (id.includes("minimax")) return "minimax";
  if (id.includes("groq")) return "groq";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fetch limits
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
/** Maximum response body size (10 MB) to prevent OOM from malicious/corrupted upstream responses. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Safely parse a fetch Response as JSON with a size limit.
 * Uses streaming body reader when available, falls back to response.json() for
 * environments where .body is not a ReadableStream (e.g., test mocks).
 * Throws if the response exceeds MAX_RESPONSE_BYTES.
 */
async function safeJsonParse<T>(response: Response, label: string): Promise<T> {
  // Check Content-Length header first (fast-reject)
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_BYTES})`);
  }

  // Stream-read with size tracking for chunked/unknown-length responses
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          reader.cancel();
          throw new Error(`${label} response too large: >${MAX_RESPONSE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      releaseStreamReader(reader);
    }

    const decoder = new TextDecoder();
    const text = chunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
    return JSON.parse(text) as T;
  }

  // Fallback for environments without ReadableStream body (e.g., test mocks)
  return response.json() as Promise<T>;
}

async function safeTextParse(response: Response, label: string): Promise<string> {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_BYTES})`);
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          reader.cancel();
          throw new Error(`${label} response too large: >${MAX_RESPONSE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      releaseStreamReader(reader);
    }

    const decoder = new TextDecoder();
    return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
  }

  return response.text();
}

// ---------------------------------------------------------------------------
// Feed provider names
// ---------------------------------------------------------------------------

/**
 * Feed spellings of providers Strada knows under another name. LiteLLM and
 * models.dev each name providers their own way, and a row filed under
 * "together_ai" or "anthropic" was invisible to a lookup for "together" or
 * "claude", so those providers looked catalog-less.
 */
const FEED_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "claude",
  together_ai: "together",
  togetherai: "together",
  fireworks_ai: "fireworks",
  "fireworks-ai": "fireworks",
  moonshot: "kimi",
  moonshotai: "kimi",
  "moonshotai-cn": "kimi",
  dashscope: "qwen",
  alibaba: "qwen",
  google: "gemini",
  ollama_chat: "ollama",
};

/** A feed's provider name as the key Strada stores and looks provider rows up by. */
function feedProviderKey(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return providerRecordKey(FEED_PROVIDER_ALIASES[lower] ?? lower);
}

/**
 * Whether `candidate` should take an id slot `existing` already holds.
 *
 * Feeds list one model id under several providers (a bare "gemini-2.5-pro" is
 * Vertex's row in LiteLLM; "gemini/gemini-2.5-pro" is Google's), and the
 * registry keeps one row per id. The row from the model's own maker wins;
 * otherwise the first row seen keeps the slot.
 */
function preferFeedRow(existing: { provider?: string } | undefined, candidate: { provider?: string }, id: string): boolean {
  if (!existing) return true;
  const maker = inferProvider(id);
  return existing.provider !== maker && candidate.provider === maker;
}

/** Finite and not negative: a feed's limit or price, or nothing. */
const feedNumber = z.number().nonnegative().nullish();

// ---------------------------------------------------------------------------
// LiteLLM fetcher
// ---------------------------------------------------------------------------

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * One LiteLLM row. Validated per row, so a malformed row (or the feed's own
 * "sample_spec", whose values are prose) is skipped instead of cast into the
 * registry.
 */
const LiteLLMEntrySchema = z.object({
  max_tokens: feedNumber,
  max_input_tokens: feedNumber,
  max_output_tokens: feedNumber,
  input_cost_per_token: feedNumber,
  output_cost_per_token: feedNumber,
  supports_vision: z.boolean().nullish(),
  supports_function_calling: z.boolean().nullish(),
  supports_tool_choice: z.boolean().nullish(),
  mode: z.string().nullish(),
  litellm_provider: z.string().min(1).nullish(),
});

/**
 * LiteLLM modes a chat request can use. The feed also lists embedding, speech,
 * image and rerank models, and those flooded the model picker for "openai".
 */
const LITELLM_CHAT_MODES = new Set(["chat", "responses"]);

function parseLiteLLMFeed(data: unknown, now: number): Map<string, ModelInfo> {
  const map = new Map<string, ModelInfo>();
  if (!data || typeof data !== "object" || Array.isArray(data)) return map;

  for (const [key, raw] of Object.entries(data)) {
    const parsed = LiteLLMEntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (!entry.max_tokens && !entry.max_input_tokens && !entry.max_output_tokens) continue;
    if (entry.mode && !LITELLM_CHAT_MODES.has(entry.mode)) continue;

    const maxOutputTokens = entry.max_output_tokens ?? entry.max_tokens ?? 0;
    // Some catalog entries (often provider aliases) omit context-window
    // metadata but are still valid, selectable models. Dropping them here
    // starved the model picker (e.g. only the default OpenAI model showed up
    // even though the catalog had 2000+ models). Keep them with a
    // conservative fallback context window instead of discarding them.
    const contextWindow =
      (entry.max_input_tokens ?? entry.max_tokens)
      ?? (maxOutputTokens > 0 ? maxOutputTokens : 8000);

    // Prices in LiteLLM are per-token; convert to per-million
    const inputPricePerMillion = (entry.input_cost_per_token ?? 0) * 1_000_000;
    const outputPricePerMillion = (entry.output_cost_per_token ?? 0) * 1_000_000;

    // Strip the route prefix: "groq/llama-3.3-70b-versatile" is Groq's
    // "llama-3.3-70b-versatile", "openrouter/anthropic/x" is OpenRouter's "anthropic/x".
    const slashIdx = key.indexOf("/");
    const id = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
    if (!id) continue;

    const provider = entry.litellm_provider
      ? feedProviderKey(entry.litellm_provider)
      : inferProvider(id, key);

    if (!preferFeedRow(map.get(id), { provider }, id)) continue;

    map.set(id, {
      id,
      provider,
      contextWindow,
      maxOutputTokens,
      inputPricePerMillion: Math.round(inputPricePerMillion * 100) / 100,
      outputPricePerMillion: Math.round(outputPricePerMillion * 100) / 100,
      supportsVision: entry.supports_vision ?? false,
      supportsThinking: /claude-(opus|sonnet)|deepseek|kimi-k2|o[34]-|qwen.*thinking/i.test(id),
      supportsToolCalling:
        entry.supports_function_calling ?? entry.supports_tool_choice ?? false,
      supportsStreaming: true, // Assume true for API-based models
      lastUpdated: now,
    });
  }
  return map;
}

async function fetchLiteLLM(): Promise<Map<string, ModelInfo>> {
  const logger = getLogger();
  let map = new Map<string, ModelInfo>();

  try {
    const response = await fetch(LITELLM_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("LiteLLM fetch failed", { status: response.status });
      return map;
    }

    const data = await safeJsonParse<unknown>(response, "LiteLLM");
    map = parseLiteLLMFeed(data, Date.now());

    logger.info("LiteLLM fetch complete", { modelCount: map.size });
  } catch (error) {
    logger.warn("LiteLLM fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// models.dev fetcher
// ---------------------------------------------------------------------------

const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * models.dev is keyed by provider, and each provider holds its models:
 * `{ [providerId]: { name, models: { [modelId]: { limit, cost, tool_call, … } } } }`.
 * Reading the top level as models turned every provider into a bogus model
 * with no limits and enriched nothing.
 */
const ModelsDevProviderSchema = z.object({
  models: z.record(z.string(), z.unknown()),
});

const ModelsDevModelSchema = z.object({
  id: z.string().min(1).nullish(),
  reasoning: z.boolean().nullish(),
  tool_call: z.boolean().nullish(),
  attachment: z.boolean().nullish(),
  modalities: z.object({ input: z.array(z.string()).nullish() }).nullish(),
  // Already per million tokens, unlike LiteLLM's per-token prices.
  cost: z.object({ input: feedNumber, output: feedNumber }).nullish(),
  limit: z.object({ context: feedNumber, output: feedNumber }).nullish(),
});

function parseModelsDevFeed(data: unknown, now: number): Map<string, Partial<ModelInfo>> {
  const map = new Map<string, Partial<ModelInfo>>();
  if (!data || typeof data !== "object" || Array.isArray(data)) return map;

  for (const [providerId, rawProvider] of Object.entries(data)) {
    const providerEntry = ModelsDevProviderSchema.safeParse(rawProvider);
    if (!providerEntry.success) continue;
    const provider = feedProviderKey(providerId);

    for (const [modelKey, rawModel] of Object.entries(providerEntry.data.models)) {
      const parsed = ModelsDevModelSchema.safeParse(rawModel);
      if (!parsed.success) continue;
      const model = parsed.data;
      const id = model.id ?? modelKey;
      if (!id) continue;
      if (!preferFeedRow(map.get(id), { provider }, id)) continue;

      const inputs = model.modalities?.input;
      map.set(id, {
        id,
        provider,
        lastUpdated: now,
        ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
        ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
        ...(model.cost?.input != null ? { inputPricePerMillion: model.cost.input } : {}),
        ...(model.cost?.output != null ? { outputPricePerMillion: model.cost.output } : {}),
        ...(inputs ? { supportsVision: inputs.includes("image") } : {}),
        ...(model.tool_call != null ? { supportsToolCalling: model.tool_call } : {}),
        ...(model.reasoning != null ? { supportsThinking: model.reasoning } : {}),
      });
    }
  }
  return map;
}

async function fetchModelsDev(): Promise<Map<string, Partial<ModelInfo>>> {
  const logger = getLogger();
  let map = new Map<string, Partial<ModelInfo>>();

  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("models.dev fetch failed", { status: response.status });
      return map;
    }

    const data = await safeJsonParse<unknown>(response, "models.dev");
    map = parseModelsDevFeed(data, Date.now());

    logger.info("models.dev fetch complete", { modelCount: map.size });
  } catch (error) {
    logger.warn("models.dev fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge models.dev partial data into a full ModelInfo map.
 * models.dev enriches boolean capabilities but does not overwrite numeric fields.
 */
function mergeEnrichment(
  primary: Map<string, ModelInfo>,
  enrichment: Map<string, Partial<ModelInfo>>,
): void {
  for (const [id, partial] of enrichment) {
    const existing = primary.get(id);
    if (existing) {
      // Enrich boolean fields only (primary wins on numeric fields)
      primary.set(id, {
        ...existing,
        supportsVision: existing.supportsVision || (partial.supportsVision ?? false),
        supportsToolCalling: existing.supportsToolCalling || (partial.supportsToolCalling ?? false),
      });
    } else if (partial.contextWindow) {
      // New model from enrichment — only with a real context window: a row
      // without one would enter the registry claiming a window of 0.
      primary.set(id, {
        id: partial.id ?? id,
        provider: partial.provider ?? inferProvider(id),
        contextWindow: partial.contextWindow,
        maxOutputTokens: partial.maxOutputTokens ?? 0,
        inputPricePerMillion: partial.inputPricePerMillion ?? 0,
        outputPricePerMillion: partial.outputPricePerMillion ?? 0,
        supportsVision: partial.supportsVision ?? false,
        supportsThinking: partial.supportsThinking ?? false,
        supportsToolCalling: partial.supportsToolCalling ?? false,
        supportsStreaming: true,
        lastUpdated: partial.lastUpdated ?? Date.now(),
      });
    }
  }
}

/**
 * Lay the static catalog over remote data. The static catalog is the single
 * source of truth for the models it declares — their identity and declared
 * limits — and remote feeds only fill in models it does not know. A feed row
 * for a declared id is replaced, never merged: a feed's context window or
 * provider for a model Strada has pinned must not change what Strada plans
 * against.
 */
function overlayStaticCatalog(models: Map<string, ModelInfo>): void {
  for (const [id, model] of HARDCODED_MODELS) {
    models.set(id, model);
  }
}

// ---------------------------------------------------------------------------
// SQLite row types
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  provider: string;
  context_window: number;
  max_output_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  supports_vision: number;
  supports_thinking: number;
  supports_tool_calling: number;
  supports_streaming: number;
  last_updated: number;
}

interface MetaRow {
  key: string;
  value: string;
}

interface ProviderSnapshotRow {
  provider: string;
  last_updated: number;
  source_urls_json: string;
  signals_json: string;
  feature_tags_json: string;
}

// ---------------------------------------------------------------------------
// Row conversion helper
// ---------------------------------------------------------------------------

function rowToModelInfo(row: ModelRow): ModelInfo {
  return {
    id: row.id,
    provider: row.provider,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    inputPricePerMillion: row.input_price_per_million,
    outputPricePerMillion: row.output_price_per_million,
    supportsVision: row.supports_vision === 1,
    supportsThinking: row.supports_thinking === 1,
    supportsToolCalling: row.supports_tool_calling === 1,
    supportsStreaming: row.supports_streaming === 1,
    lastUpdated: row.last_updated,
  };
}

// ---------------------------------------------------------------------------
// ModelIntelligenceService
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_HOURS = 24;

export interface ModelIntelligenceServiceOptions {
  readonly refreshHours?: number;
  readonly providerSourcesPath?: string;
}

export interface InitializeModelIntelligenceOptions {
  readonly refreshOnInitialize?: boolean;
}

export class ModelIntelligenceService {
  private db: Database.Database | null = null;
  private models: Map<string, ModelInfo> = new Map();
  private providerSnapshots: Map<string, ProviderOfficialSnapshot> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRefreshTimestamp = 0;

  private stmtUpsert!: Database.Statement;
  private stmtGetAll!: Database.Statement;
  private stmtClearModels!: Database.Statement;
  private stmtUpsertProviderSnapshot!: Database.Statement;
  private stmtGetProviderSnapshots!: Database.Statement;
  private stmtClearProviderSnapshots!: Database.Statement;
  private stmtSetMeta!: Database.Statement;
  private stmtGetMeta!: Database.Statement;

  constructor(private readonly options: ModelIntelligenceServiceOptions = {}) {}

  private get refreshIntervalMs(): number {
    const hours = this.options.refreshHours ?? DEFAULT_REFRESH_HOURS;
    return hours * 60 * 60 * 1000;
  }

  private needsRefresh(): boolean {
    return this.isStale();
  }

  /**
   * Initialize the service: open/create DB, load cache, refresh if stale,
   * and start the periodic refresh timer.
   */
  async initialize(
    dbPath: string,
    options: InitializeModelIntelligenceOptions = {},
  ): Promise<void> {
    const logger = getLogger();

    try {
      const dir = dirname(dbPath);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(dbPath);
      configureSqlitePragmas(this.db, "preferences");
      this.createTables();
      this.prepareStatements();
      this.loadFromDb();

      logger.info("ModelIntelligence initialized", {
        cachedModels: this.models.size,
        dbPath,
      });

      const shouldRefreshOnInitialize = options.refreshOnInitialize ?? true;
      if (shouldRefreshOnInitialize && this.needsRefresh()) {
        const result = await this.refresh();
        logger.info("ModelIntelligence initial refresh", {
          modelsUpdated: result.modelsUpdated,
          source: result.source,
          errors: result.errors.length,
        });
      }

      this.startRefreshTimer();

      if (!shouldRefreshOnInitialize && this.needsRefresh()) {
        const initialRefresh = setTimeout(() => {
          this.refresh().catch((error) => {
            logger.warn("ModelIntelligence deferred refresh failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 0);
        if (initialRefresh.unref) {
          initialRefresh.unref();
        }
      }
    } catch (error) {
      logger.warn("ModelIntelligence DB init failed, using hardcoded fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.db?.close();
      this.db = null;
      this.models = new Map(HARDCODED_MODELS);
    }
  }

  /**
   * Fetch model data from external sources, merge, and persist.
   * Falls back gracefully through the source chain.
   */
  async refresh(): Promise<RefreshResult> {
    const logger = getLogger();
    const errors: string[] = [];

    const officialSourceErrors = await this.refreshProviderOfficialSnapshots();
    errors.push(...officialSourceErrors);

    // 1. Try LiteLLM (primary)
    let fetched: Map<string, ModelInfo>;
    try {
      fetched = await fetchLiteLLM();
    } catch (error) {
      const msg = `LiteLLM: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(msg);
      fetched = new Map();
    }

    // 2. Try models.dev (enrichment)
    let enrichment: Map<string, Partial<ModelInfo>>;
    try {
      enrichment = await fetchModelsDev();
    } catch (error) {
      const msg = `models.dev: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(msg);
      enrichment = new Map();
    }

    // 3. Merge enrichment into primary
    if (fetched.size > 0) {
      mergeEnrichment(fetched, enrichment);
      overlayStaticCatalog(fetched);
      this.models = fetched;

      this.saveToDb();
      this.setLastRefresh(Date.now());

      logger.info("ModelIntelligence refreshed from LiteLLM", {
        modelCount: this.models.size,
      });

      return { modelsUpdated: this.models.size, source: "litellm", errors };
    }

    // 4. models.dev only (LiteLLM returned nothing)
    if (enrichment.size > 0) {
      const fromEnrichment = new Map<string, ModelInfo>();
      mergeEnrichment(fromEnrichment, enrichment);

      for (const [id, model] of fromEnrichment) {
        if (!this.models.has(id)) {
          this.models.set(id, model);
        }
      }
      overlayStaticCatalog(this.models);

      this.saveToDb();
      this.setLastRefresh(Date.now());

      logger.info("ModelIntelligence refreshed from models.dev", {
        modelCount: this.models.size,
      });

      return { modelsUpdated: this.models.size, source: "models.dev", errors };
    }

    // 5. Both fetchers failed — use cached data if available
    if (this.models.size > 0) {
      logger.warn("ModelIntelligence refresh failed, using cached data", { errors });
      return { modelsUpdated: 0, source: "cache", errors };
    }

    // 6. No cache either — use hardcoded
    this.models = new Map(HARDCODED_MODELS);
    this.setLastRefresh(Date.now());
    this.saveToDb();
    logger.warn("ModelIntelligence using hardcoded fallback", { errors });

    return { modelsUpdated: HARDCODED_MODELS.size, source: "hardcoded", errors };
  }

  /**
   * Look up a model by its id. Falls back to hardcoded if not found in live registry.
   *
   * Preset default model ids are sometimes slash-prefixed/aliased
   * (e.g. "openai/gpt-oss-120b", "meta-llama/Llama-4-...", "accounts/fireworks/models/...").
   * The remote catalog (LiteLLM) stores entries under the prefix-stripped id
   * (everything after the last "/"). To reconcile the keyspace we try the exact id
   * first, then the prefix-stripped tail, against both the live and hardcoded maps.
   */
  getModelInfo(modelId: string): ModelInfo | undefined {
    // Static catalog first: it is the source of truth for the models it declares.
    const exact = HARDCODED_MODELS.get(modelId) ?? this.models.get(modelId);
    if (exact) return exact;

    const slashIdx = modelId.lastIndexOf("/");
    if (slashIdx >= 0) {
      const stripped = modelId.slice(slashIdx + 1);
      if (stripped && stripped !== modelId) {
        return HARDCODED_MODELS.get(stripped) ?? this.models.get(stripped);
      }
    }
    return undefined;
  }

  /** Return all models for a given provider name. */
  getProviderModels(provider: string): ModelInfo[] {
    // Rows are stored under Strada's provider key (see feedProviderKey), so a
    // lookup by any accepted spelling ("anthropic", "Kimi (Moonshot)") folds too.
    const key = providerRecordKey(provider);
    const results: ModelInfo[] = [];
    for (const model of this.models.values()) {
      if (model.provider === key) {
        results.push(model);
      }
    }
    return results;
  }

  getProviderOfficialSnapshot(provider: string): ProviderOfficialSnapshot | undefined {
    return this.providerSnapshots.get(provider.toLowerCase());
  }

  getCatalogHealth(provider?: string): ProviderCatalogHealth | undefined {
    const normalizedProvider = provider?.trim().toLowerCase();
    const snapshot = normalizedProvider ? this.providerSnapshots.get(normalizedProvider) : undefined;
    const snapshotAgeMs = snapshot ? Math.max(0, Date.now() - snapshot.lastUpdated) : undefined;
    return {
      refreshIntervalMs: this.refreshIntervalMs,
      stale: snapshotAgeMs !== undefined
        ? snapshotAgeMs > this.refreshIntervalMs
        : this.isStale(),
      snapshotAgeMs,
    };
  }

  /** Returns true if the last refresh was more than the configured interval ago. */
  isStale(): boolean {
    const lastRefresh = this.lastRefreshTimestamp || this.getLastRefresh();
    if (lastRefresh === 0) return true;
    return Date.now() - lastRefresh > this.refreshIntervalMs;
  }

  /**
   * Every model currently in the registry.
   *
   * The registry is the merge of (a) the SQLite cache written by the last
   * successful refresh and (b) the embedded seed list, so this reflects live
   * catalog data whenever a refresh has ever succeeded on this machine, and
   * degrades to the seed list otherwise. Callers that need to rank or offer
   * models — delegation tier derivation, the setup wizard — read this rather
   * than embedding their own list.
   */
  getAllModels(): ModelInfo[] {
    return [...this.models.values()];
  }

  /** Total number of models currently in the registry. */
  get size(): number {
    return this.models.size;
  }

  /** Stop the refresh timer and close the database. */
  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.db?.close();
    this.db = null;
  }

  // -------------------------------------------------------------------------
  // Private: SQLite operations
  // -------------------------------------------------------------------------

  private createTables(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS model_info (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        context_window INTEGER NOT NULL,
        max_output_tokens INTEGER NOT NULL,
        input_price_per_million REAL NOT NULL,
        output_price_per_million REAL NOT NULL,
        supports_vision INTEGER NOT NULL DEFAULT 0,
        supports_thinking INTEGER NOT NULL DEFAULT 0,
        supports_tool_calling INTEGER NOT NULL DEFAULT 0,
        supports_streaming INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL
      )
    `);

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS model_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS provider_official_snapshot (
        provider TEXT PRIMARY KEY,
        last_updated INTEGER NOT NULL,
        source_urls_json TEXT NOT NULL,
        signals_json TEXT NOT NULL,
        feature_tags_json TEXT NOT NULL
      )
    `);
  }

  private prepareStatements(): void {
    this.stmtUpsert = this.db!.prepare(`
      INSERT OR REPLACE INTO model_info
        (id, provider, context_window, max_output_tokens,
         input_price_per_million, output_price_per_million,
         supports_vision, supports_thinking, supports_tool_calling, supports_streaming,
         last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetAll = this.db!.prepare("SELECT * FROM model_info");

    this.stmtClearModels = this.db!.prepare("DELETE FROM model_info");

    this.stmtUpsertProviderSnapshot = this.db!.prepare(`
      INSERT OR REPLACE INTO provider_official_snapshot
        (provider, last_updated, source_urls_json, signals_json, feature_tags_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetProviderSnapshots = this.db!.prepare(
      "SELECT * FROM provider_official_snapshot",
    );

    this.stmtClearProviderSnapshots = this.db!.prepare(
      "DELETE FROM provider_official_snapshot",
    );

    this.stmtSetMeta = this.db!.prepare(
      "INSERT OR REPLACE INTO model_meta (key, value) VALUES (?, ?)",
    );

    this.stmtGetMeta = this.db!.prepare(
      "SELECT value FROM model_meta WHERE key = ?",
    );
  }

  private loadFromDb(): void {
    if (!this.db) return;

    try {
      const rows = this.stmtGetAll.all() as ModelRow[];
      for (const row of rows) {
        // A cache written before feed names were mapped holds rows under
        // "anthropic", "together_ai", …; read them under Strada's key.
        const model = rowToModelInfo(row);
        this.models.set(row.id, { ...model, provider: feedProviderKey(model.provider) });
      }
      if (this.models.size > 0) overlayStaticCatalog(this.models);
    } catch {
      // DB might be empty on first run
    }

    try {
      const snapshotRows = this.stmtGetProviderSnapshots.all() as ProviderSnapshotRow[];
      for (const row of snapshotRows) {
        try {
          this.providerSnapshots.set(row.provider, {
            provider: row.provider,
            lastUpdated: row.last_updated,
            sourceUrls: JSON.parse(row.source_urls_json) as string[],
            signals: JSON.parse(row.signals_json) as ProviderOfficialSnapshot["signals"],
            featureTags: JSON.parse(row.feature_tags_json) as string[],
          });
        } catch (err) {
          getLogger().warn("ModelIntelligence: skipping corrupt provider snapshot row", {
            provider: row.provider,
            err,
          });
        }
      }
    } catch {
      // DB might be empty or older schema on first run
    }
  }

  private saveToDb(): void {
    if (!this.db) return;

    try {
      const upsertMany = this.db.transaction((models: ModelInfo[]) => {
        // The in-memory map is the whole registry, so the table is replaced
        // rather than upserted: rows a refresh no longer produces (non-chat
        // models, rows under a feed's own provider name) must not reload.
        this.stmtClearModels.run();
        for (const m of models) {
          this.stmtUpsert.run(
            m.id,
            m.provider,
            m.contextWindow,
            m.maxOutputTokens,
            m.inputPricePerMillion,
            m.outputPricePerMillion,
            m.supportsVision ? 1 : 0,
            m.supportsThinking ? 1 : 0,
            m.supportsToolCalling ? 1 : 0,
            m.supportsStreaming ? 1 : 0,
            m.lastUpdated,
          );
        }
      });

      upsertMany([...this.models.values()]);
    } catch (error) {
      getLogger().warn("ModelIntelligence DB save failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private saveProviderSnapshotsToDb(): void {
    if (!this.db) return;

    try {
      const upsertMany = this.db.transaction((snapshots: ProviderOfficialSnapshot[]) => {
        this.stmtClearProviderSnapshots.run();
        for (const snapshot of snapshots) {
          this.stmtUpsertProviderSnapshot.run(
            snapshot.provider,
            snapshot.lastUpdated,
            JSON.stringify(snapshot.sourceUrls),
            JSON.stringify(snapshot.signals),
            JSON.stringify(snapshot.featureTags),
          );
        }
      });

      upsertMany([...this.providerSnapshots.values()]);
    } catch (error) {
      getLogger().warn("Provider official snapshot save failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getLastRefresh(): number {
    if (!this.db) return 0;
    try {
      const row = this.stmtGetMeta.get("last_refresh") as MetaRow | undefined;
      return row ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  private setLastRefresh(timestamp: number): void {
    this.lastRefreshTimestamp = timestamp;
    if (!this.db) return;
    try {
      this.stmtSetMeta.run("last_refresh", String(timestamp));
    } catch {
      // Non-critical
    }
  }

  // -------------------------------------------------------------------------
  // Private: Refresh timer
  // -------------------------------------------------------------------------

  private startRefreshTimer(): void {
    if (this.refreshTimer) return;

    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error) => {
        getLogger().warn("ModelIntelligence periodic refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.refreshIntervalMs);

    // Allow the process to exit even if the timer is running
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }
  }

  private async fetchOfficialSourceContent(source: ProviderOfficialSource): Promise<string> {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "Strada.Brain/1.0 (+https://github.com/okandemirel/Strada.Brain)",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return safeTextParse(response, source.label ?? source.url);
  }

  private async refreshProviderOfficialSnapshots(): Promise<string[]> {
    const logger = getLogger();
    const registry = loadProviderSourceRegistry(
      this.options.providerSourcesPath ?? DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH,
    );
    const providers = Object.entries(registry.providers);
    if (providers.length === 0) {
      return [];
    }

    const errors: string[] = [];
    const nextSnapshots = new Map<string, ProviderOfficialSnapshot>();
    let hadSuccessfulFetch = false;

    for (const [provider, sources] of providers) {
      const providerSignals: ProviderOfficialSnapshot["signals"] = [];
      const sourceUrls: string[] = [];
      let fetchedSourceCount = 0;

      for (const source of sources) {
        try {
          const content = await this.fetchOfficialSourceContent(source);
          fetchedSourceCount += 1;
          hadSuccessfulFetch = true;
          providerSignals.push(...extractProviderOfficialSignals(provider, source, content));
          sourceUrls.push(source.url);
        } catch (error) {
          errors.push(`${provider}:${source.url} — ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (providerSignals.length === 0) {
        const cached = this.providerSnapshots.get(provider);
        if (cached && fetchedSourceCount === 0) {
          nextSnapshots.set(provider, cached);
        }
        continue;
      }

      const featureTags = [...new Set(providerSignals.flatMap((signal) => signal.tags))];
      nextSnapshots.set(provider, {
        provider,
        lastUpdated: Date.now(),
        sourceUrls,
        signals: providerSignals.slice(0, 20),
        featureTags,
      });
    }

    if (hadSuccessfulFetch || nextSnapshots.size > 0) {
      this.providerSnapshots = nextSnapshots;
      this.saveProviderSnapshotsToDb();
      logger.info("Provider official sources refreshed", {
        providers: nextSnapshots.size,
      });
    }

    return errors;
  }
}
