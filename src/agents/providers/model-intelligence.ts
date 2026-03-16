/**
 * Model Intelligence Service
 *
 * Self-updating model metadata service that fetches model information from
 * external sources (LiteLLM, models.dev), caches in SQLite, and provides
 * a hardcoded fallback registry for offline operation.
 *
 * Merge strategy: LiteLLM (primary) -> models.dev (enrichment) -> SQLite cache -> hardcoded fallback.
 * Refresh interval: 24h (configurable via MODEL_INTELLIGENCE_REFRESH_HOURS).
 */

import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import { getLogger } from "../../utils/logger.js";

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

export interface RefreshResult {
  readonly modelsUpdated: number;
  readonly source: "litellm" | "models.dev" | "cache" | "hardcoded";
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// Hardcoded fallback registry
// ---------------------------------------------------------------------------

function buildHardcoded(): Map<string, ModelInfo> {
  const now = Date.now();
  const entries: Array<Omit<ModelInfo, "lastUpdated">> = [
    {
      id: "claude-sonnet-4-6-20250514",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-opus-4-6-20250514",
      provider: "claude",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      inputPricePerMillion: 5,
      outputPricePerMillion: 25,
      supportsVision: true,
      supportsThinking: true,
      supportsToolCalling: true,
      supportsStreaming: true,
    },
    {
      id: "claude-haiku-4-5-20251001",
      provider: "claude",
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
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
function inferProvider(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("gpt") || id.includes("o1") || id.includes("o3") || id.includes("o4")) return "openai";
  if (id.includes("gemini")) return "gemini";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("qwen")) return "qwen";
  if (id.includes("kimi") || id.includes("moonshot")) return "kimi";
  if (id.includes("mistral") || id.includes("codestral") || id.includes("pixtral")) return "mistral";
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
      reader.releaseLock();
    }

    const decoder = new TextDecoder();
    const text = chunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
    return JSON.parse(text) as T;
  }

  // Fallback for environments without ReadableStream body (e.g., test mocks)
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// LiteLLM fetcher
// ---------------------------------------------------------------------------

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface LiteLLMEntry {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_tool_choice?: boolean;
  mode?: string;
  litellm_provider?: string;
}

async function fetchLiteLLM(): Promise<Map<string, ModelInfo>> {
  const logger = getLogger();
  const map = new Map<string, ModelInfo>();

  try {
    const response = await fetch(LITELLM_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("LiteLLM fetch failed", { status: response.status });
      return map;
    }

    const data = await safeJsonParse<Record<string, LiteLLMEntry>>(response, "LiteLLM");
    const now = Date.now();

    for (const [key, entry] of Object.entries(data)) {
      // Skip metadata keys (e.g. "sample_spec")
      if (!entry || typeof entry !== "object" || !entry.max_tokens) continue;

      const contextWindow = entry.max_input_tokens ?? entry.max_tokens ?? 0;
      const maxOutputTokens = entry.max_output_tokens ?? entry.max_tokens ?? 0;

      if (contextWindow === 0) continue;

      // Prices in LiteLLM are per-token; convert to per-million
      const inputPricePerMillion = (entry.input_cost_per_token ?? 0) * 1_000_000;
      const outputPricePerMillion = (entry.output_cost_per_token ?? 0) * 1_000_000;

      // Strip provider prefix (e.g. "anthropic/claude-3-5-sonnet" -> "claude-3-5-sonnet")
      const slashIdx = key.indexOf("/");
      const id = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;

      const provider =
        entry.litellm_provider?.toLowerCase() ?? inferProvider(id);

      map.set(id, {
        id,
        provider,
        contextWindow,
        maxOutputTokens,
        inputPricePerMillion: Math.round(inputPricePerMillion * 100) / 100,
        outputPricePerMillion: Math.round(outputPricePerMillion * 100) / 100,
        supportsVision: entry.supports_vision ?? false,
        supportsThinking: false, // LiteLLM doesn't track this
        supportsToolCalling:
          entry.supports_function_calling ?? entry.supports_tool_choice ?? false,
        supportsStreaming: true, // Assume true for API-based models
        lastUpdated: now,
      });
    }

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

interface ModelsDevEntry {
  name?: string;
  provider?: string;
  context_length?: number;
  max_output?: number;
  input_price?: number;
  output_price?: number;
  vision?: boolean;
  tool_use?: boolean;
}

async function fetchModelsDev(): Promise<Map<string, Partial<ModelInfo>>> {
  const logger = getLogger();
  const map = new Map<string, Partial<ModelInfo>>();

  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("models.dev fetch failed", { status: response.status });
      return map;
    }

    const data = await safeJsonParse<Record<string, ModelsDevEntry> | ModelsDevEntry[]>(response, "models.dev");
    const now = Date.now();

    const entries: Array<[string, ModelsDevEntry]> = Array.isArray(data)
      ? data.map((e, i) => [e.name ?? String(i), e])
      : Object.entries(data);

    for (const [key, entry] of entries) {
      if (!entry || typeof entry !== "object") continue;

      const id = entry.name ?? key;
      const partial: Partial<ModelInfo> = {
        id,
        lastUpdated: now,
        ...(entry.provider ? { provider: entry.provider.toLowerCase() } : {}),
        ...(entry.context_length ? { contextWindow: entry.context_length } : {}),
        ...(entry.max_output ? { maxOutputTokens: entry.max_output } : {}),
        ...(entry.input_price != null ? { inputPricePerMillion: entry.input_price } : {}),
        ...(entry.output_price != null ? { outputPricePerMillion: entry.output_price } : {}),
        ...(entry.vision != null ? { supportsVision: entry.vision } : {}),
        ...(entry.tool_use != null ? { supportsToolCalling: entry.tool_use } : {}),
      };

      map.set(id, partial);
    }

    logger.info("models.dev fetch complete", { modelCount: map.size });
  } catch (error) {
    logger.warn("models.dev fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Merge helper
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
    } else {
      // New model from enrichment — fill in defaults for missing fields
      primary.set(id, {
        id: partial.id ?? id,
        provider: partial.provider ?? inferProvider(id),
        contextWindow: partial.contextWindow ?? 0,
        maxOutputTokens: partial.maxOutputTokens ?? 0,
        inputPricePerMillion: partial.inputPricePerMillion ?? 0,
        outputPricePerMillion: partial.outputPricePerMillion ?? 0,
        supportsVision: partial.supportsVision ?? false,
        supportsThinking: false,
        supportsToolCalling: partial.supportsToolCalling ?? false,
        supportsStreaming: true,
        lastUpdated: partial.lastUpdated ?? Date.now(),
      });
    }
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

export class ModelIntelligenceService {
  private db: Database.Database | null = null;
  private models: Map<string, ModelInfo> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRefreshTimestamp = 0;

  private stmtUpsert!: Database.Statement;
  private stmtGetAll!: Database.Statement;
  private stmtSetMeta!: Database.Statement;
  private stmtGetMeta!: Database.Statement;

  private get refreshIntervalMs(): number {
    const hours = Number(process.env["MODEL_INTELLIGENCE_REFRESH_HOURS"]) || DEFAULT_REFRESH_HOURS;
    return hours * 60 * 60 * 1000;
  }

  /**
   * Initialize the service: open/create DB, load cache, refresh if stale,
   * and start the periodic refresh timer.
   */
  async initialize(dbPath: string): Promise<void> {
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

      if (this.isStale()) {
        const result = await this.refresh();
        logger.info("ModelIntelligence initial refresh", {
          modelsUpdated: result.modelsUpdated,
          source: result.source,
          errors: result.errors.length,
        });
      }

      this.startRefreshTimer();
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
      this.models = fetched;

      // Ensure hardcoded entries are always present (future/custom models not in LiteLLM)
      for (const [id, model] of HARDCODED_MODELS) {
        if (!this.models.has(id)) {
          this.models.set(id, model);
        }
      }

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

      for (const [id, model] of HARDCODED_MODELS) {
        if (!this.models.has(id)) {
          this.models.set(id, model);
        }
      }

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
    logger.warn("ModelIntelligence using hardcoded fallback", { errors });

    return { modelsUpdated: HARDCODED_MODELS.size, source: "hardcoded", errors };
  }

  /** Look up a model by its id. Falls back to hardcoded if not found in live registry. */
  getModelInfo(modelId: string): ModelInfo | undefined {
    return this.models.get(modelId) ?? HARDCODED_MODELS.get(modelId);
  }

  /** Return all models for a given provider name. */
  getProviderModels(provider: string): ModelInfo[] {
    const lowerProvider = provider.toLowerCase();
    const results: ModelInfo[] = [];
    for (const model of this.models.values()) {
      if (model.provider.toLowerCase() === lowerProvider) {
        results.push(model);
      }
    }
    return results;
  }

  /** Returns true if the last refresh was more than the configured interval ago. */
  isStale(): boolean {
    const lastRefresh = this.lastRefreshTimestamp || this.getLastRefresh();
    if (lastRefresh === 0) return true;
    return Date.now() - lastRefresh > this.refreshIntervalMs;
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
        this.models.set(row.id, rowToModelInfo(row));
      }
    } catch {
      // DB might be empty on first run
    }
  }

  private saveToDb(): void {
    if (!this.db) return;

    try {
      const upsertMany = this.db.transaction((models: ModelInfo[]) => {
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
}
