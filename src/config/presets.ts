/**
 * System Presets — Pre-configured provider profiles for different budgets.
 *
 * Each preset defines: LLM provider chain, delegation tiers, embedding config,
 * and estimated monthly cost. All pricing verified March 2026.
 *
 * Usage: Set SYSTEM_PRESET env var (free/budget/balanced/performance/premium)
 * or configure manually via individual env vars. Manual config overrides presets.
 *
 * Sources:
 * - Claude: https://platform.claude.com/docs/en/about-claude/pricing
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 * - Groq: https://groq.com/pricing
 * - Gemini: https://ai.google.dev/gemini-api/docs/pricing
 * - Together: https://www.together.ai/pricing
 * - Kimi: https://openrouter.ai/moonshotai/kimi-k2.5
 * - OpenAI: https://platform.openai.com/docs/models
 * - Mistral: https://docs.mistral.ai/getting-started/models/
 * - Fireworks: https://docs.fireworks.ai/getting-started/pricing
 * - Embedding: https://awesomeagents.ai/pricing/embedding-models-pricing/
 */

export type PresetName = "free" | "budget" | "balanced" | "performance" | "premium";

export interface SystemPreset {
  readonly name: PresetName;
  readonly label: string;
  readonly description: string;
  /** Estimated monthly cost at ~50 messages/day (2K in + 1K out tokens each) */
  readonly estimatedMonthlyCost: string;

  // --- LLM ---
  /** Comma-separated provider chain (first = primary, rest = fallback) */
  readonly providerChain: string;
  /** Per-provider model overrides */
  readonly providerModels: Record<string, string>;

  // --- Delegation Tiers ---
  readonly delegationTierLocal: string;
  readonly delegationTierCheap: string;
  readonly delegationTierStandard: string;
  readonly delegationTierPremium: string;

  // --- Embedding ---
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingBaseUrl?: string;

  // --- Pricing reference (per 1M tokens) ---
  readonly pricing: {
    readonly chat: { readonly input: number; readonly output: number; readonly model: string };
    readonly embedding: { readonly perMillion: number; readonly model: string };
    readonly delegation: {
      readonly cheap: { readonly input: number; readonly output: number; readonly model: string };
      readonly premium: { readonly input: number; readonly output: number; readonly model: string };
    };
  };
}

/**
 * All system presets, ordered from cheapest to most expensive.
 * Pricing data verified March 2026.
 */
export const SYSTEM_PRESETS: Record<PresetName, SystemPreset> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // FREE — $0/month, runs entirely on local models via Ollama
  // ═══════════════════════════════════════════════════════════════════════════
  free: {
    name: "free",
    label: "Free (Local Only)",
    description: "Ollama local models only. No API costs. Requires ~8GB RAM for llama3.3.",
    estimatedMonthlyCost: "$0",
    providerChain: "ollama",
    providerModels: { ollama: "llama3.3" },
    delegationTierLocal: "ollama:llama3.3",
    delegationTierCheap: "ollama:llama3.3",
    delegationTierStandard: "ollama:llama3.3",
    delegationTierPremium: "ollama:llama3.3",
    embeddingProvider: "ollama",
    embeddingModel: "nomic-embed-text",
    pricing: {
      chat: { input: 0, output: 0, model: "llama3.3 (local)" },
      embedding: { perMillion: 0, model: "nomic-embed-text (local)" },
      delegation: {
        cheap: { input: 0, output: 0, model: "llama3.3 (local)" },
        premium: { input: 0, output: 0, model: "llama3.3 (local)" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BUDGET — ~$1-3/month, best cost/quality ratio
  // DeepSeek V3.2 for chat ($0.28/$0.42 per 1M)
  // Groq gpt-oss-120b as fallback ($0.15/$0.60 per 1M)
  // Gemini free-tier embedding (1500 req/day free)
  // ═══════════════════════════════════════════════════════════════════════════
  budget: {
    name: "budget",
    label: "Budget ($1-3/mo)",
    description: "DeepSeek V3.2 + Groq fallback. Gemini free embeddings. Best cost/quality ratio.",
    estimatedMonthlyCost: "$1-3",
    providerChain: "deepseek,groq",
    providerModels: {
      deepseek: "deepseek-chat",          // V3.2 — $0.28/$0.42 per 1M
      groq: "openai/gpt-oss-120b",       // $0.15/$0.60 per 1M, 500+ t/s
    },
    delegationTierLocal: "ollama:llama3.3",
    delegationTierCheap: "deepseek:deepseek-chat",
    delegationTierStandard: "deepseek:deepseek-chat",
    delegationTierPremium: "groq:openai/gpt-oss-120b",
    embeddingProvider: "gemini",
    embeddingModel: "gemini-embedding-exp-03-07",
    embeddingBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    pricing: {
      chat: { input: 0.28, output: 0.42, model: "deepseek-chat (V3.2)" },
      embedding: { perMillion: 0, model: "gemini-embedding (free tier, 1500 req/day)" },
      delegation: {
        cheap: { input: 0.28, output: 0.42, model: "deepseek-chat" },
        premium: { input: 0.15, output: 0.60, model: "gpt-oss-120b (Groq)" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BALANCED — ~$5-10/month, quality + speed balance
  // Gemini 3 Flash for chat ($0.50/$3.00 per 1M) — fast, 1M context
  // DeepSeek as cheap delegation ($0.28/$0.42)
  // OpenAI embeddings ($0.02 per 1M)
  // ═══════════════════════════════════════════════════════════════════════════
  balanced: {
    name: "balanced",
    label: "Balanced ($5-10/mo)",
    description: "Gemini 3 Flash + DeepSeek fallback. OpenAI embeddings. Good quality, reasonable cost.",
    estimatedMonthlyCost: "$5-10",
    providerChain: "gemini,deepseek",
    providerModels: {
      gemini: "gemini-3-flash-preview",   // $0.50/$3.00 per 1M, 1M context
      deepseek: "deepseek-chat",          // $0.28/$0.42 per 1M (fallback)
    },
    delegationTierLocal: "ollama:llama3.3",
    delegationTierCheap: "deepseek:deepseek-chat",
    delegationTierStandard: "gemini:gemini-3-flash-preview",
    delegationTierPremium: "gemini:gemini-3-flash-preview",
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    pricing: {
      chat: { input: 0.50, output: 3.00, model: "gemini-3-flash-preview" },
      embedding: { perMillion: 0.02, model: "text-embedding-3-small" },
      delegation: {
        cheap: { input: 0.28, output: 0.42, model: "deepseek-chat" },
        premium: { input: 0.50, output: 3.00, model: "gemini-3-flash" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PERFORMANCE — ~$15-30/month, high quality for serious work
  // Claude Sonnet 4.6 for chat ($3/$15 per 1M) — best tool calling
  // Gemini 3 Flash for cheap delegation ($0.50/$3.00)
  // OpenAI embeddings ($0.02 per 1M)
  // ═══════════════════════════════════════════════════════════════════════════
  performance: {
    name: "performance",
    label: "Performance ($15-30/mo)",
    description: "Claude Sonnet 4.6 + Gemini fallback. Best tool calling and code generation.",
    estimatedMonthlyCost: "$15-30",
    providerChain: "claude,gemini",
    providerModels: {
      claude: "claude-sonnet-4-6-20250514",  // $3/$15 per 1M, best tool use
      gemini: "gemini-3-flash-preview",       // $0.50/$3.00 per 1M (fallback)
    },
    delegationTierLocal: "ollama:llama3.3",
    delegationTierCheap: "gemini:gemini-3-flash-preview",
    delegationTierStandard: "claude:claude-sonnet-4-6-20250514",
    delegationTierPremium: "claude:claude-sonnet-4-6-20250514",
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    pricing: {
      chat: { input: 3.00, output: 15.00, model: "claude-sonnet-4-6" },
      embedding: { perMillion: 0.02, model: "text-embedding-3-small" },
      delegation: {
        cheap: { input: 0.50, output: 3.00, model: "gemini-3-flash" },
        premium: { input: 3.00, output: 15.00, model: "claude-sonnet-4-6" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PREMIUM — ~$50-100/month, maximum quality, no compromises
  // Claude Opus 4.6 for chat ($5/$25 per 1M) — frontier model
  // Claude Sonnet for standard delegation ($3/$15)
  // GPT-5.2 as fallback ($1.75/$14 per 1M)
  // OpenAI embeddings ($0.02 per 1M)
  // ═══════════════════════════════════════════════════════════════════════════
  premium: {
    name: "premium",
    label: "Premium ($50-100/mo)",
    description: "Claude Opus 4.6 + GPT-5.2 fallback. Maximum intelligence, no compromises.",
    estimatedMonthlyCost: "$50-100",
    providerChain: "claude,openai",
    providerModels: {
      claude: "claude-opus-4-6-20250514",    // $5/$25 per 1M, frontier
      openai: "gpt-5.2",                     // $1.75/$14 per 1M (fallback)
    },
    delegationTierLocal: "ollama:llama3.3",
    delegationTierCheap: "deepseek:deepseek-chat",
    delegationTierStandard: "claude:claude-sonnet-4-6-20250514",
    delegationTierPremium: "claude:claude-opus-4-6-20250514",
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    pricing: {
      chat: { input: 5.00, output: 25.00, model: "claude-opus-4-6" },
      embedding: { perMillion: 0.02, model: "text-embedding-3-small" },
      delegation: {
        cheap: { input: 0.28, output: 0.42, model: "deepseek-chat" },
        premium: { input: 5.00, output: 25.00, model: "claude-opus-4-6" },
      },
    },
  },
};

/**
 * Per-provider model recommendations with verified pricing.
 * Users can mix-and-match these for custom configurations.
 */
export const PROVIDER_MODEL_OPTIONS: Record<string, Array<{
  model: string;
  label: string;
  tier: "budget" | "standard" | "premium";
  inputPer1M: number;
  outputPer1M: number;
  contextWindow: string;
  notes: string;
}>> = {
  claude: [
    { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "budget", inputPer1M: 1.00, outputPer1M: 5.00, contextWindow: "200K", notes: "Fastest Claude. Good for simple tasks and delegation." },
    { model: "claude-sonnet-4-6-20250514", label: "Sonnet 4.6", tier: "standard", inputPer1M: 3.00, outputPer1M: 15.00, contextWindow: "1M", notes: "Best balance. Excellent tool calling and code generation." },
    { model: "claude-opus-4-6-20250514", label: "Opus 4.6", tier: "premium", inputPer1M: 5.00, outputPer1M: 25.00, contextWindow: "1M", notes: "Frontier model. Maximum intelligence." },
  ],
  openai: [
    { model: "gpt-4.1-mini", label: "GPT-4.1 Mini", tier: "budget", inputPer1M: 0.40, outputPer1M: 1.60, contextWindow: "1M", notes: "Fast, cheap. Good for delegation." },
    { model: "gpt-5.2", label: "GPT-5.2", tier: "standard", inputPer1M: 1.75, outputPer1M: 14.00, contextWindow: "128K", notes: "Strong reasoning. Good all-rounder." },
    { model: "gpt-5.4", label: "GPT-5.4", tier: "premium", inputPer1M: 2.50, outputPer1M: 15.00, contextWindow: "128K", notes: "Latest GPT. Best for complex professional work." },
  ],
  deepseek: [
    { model: "deepseek-chat", label: "V3.2 Chat", tier: "budget", inputPer1M: 0.28, outputPer1M: 0.42, contextWindow: "128K", notes: "Best budget option. Extremely cheap with strong quality." },
    { model: "deepseek-reasoner", label: "R1 Reasoner", tier: "standard", inputPer1M: 0.50, outputPer1M: 2.18, contextWindow: "128K", notes: "Chain-of-thought reasoning. Good for complex analysis." },
  ],
  gemini: [
    { model: "gemini-3-flash-preview", label: "Gemini 3 Flash", tier: "budget", inputPer1M: 0.50, outputPer1M: 3.00, contextWindow: "1M", notes: "Fast, 1M context. Best free-tier option." },
    { model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "standard", inputPer1M: 1.25, outputPer1M: 10.00, contextWindow: "1M", notes: "Strong coding. Good alternative to Claude." },
    { model: "gemini-3-pro-preview", label: "Gemini 3 Pro", tier: "premium", inputPer1M: 2.50, outputPer1M: 10.00, contextWindow: "1M", notes: "Latest Gemini. Multimodal." },
  ],
  groq: [
    { model: "llama-3.1-8b-instant", label: "Llama 3.1 8B", tier: "budget", inputPer1M: 0.05, outputPer1M: 0.08, contextWindow: "128K", notes: "Fastest inference (800+ t/s). Ultra cheap." },
    { model: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tier: "standard", inputPer1M: 0.15, outputPer1M: 0.60, contextWindow: "128K", notes: "Open model, fast Groq inference (500+ t/s)." },
    { model: "moonshotai/kimi-k2", label: "Kimi K2", tier: "premium", inputPer1M: 0.50, outputPer1M: 1.50, contextWindow: "128K", notes: "Kimi K2 via Groq's fast inference." },
  ],
  mistral: [
    { model: "mistral-small-latest", label: "Mistral Small", tier: "budget", inputPer1M: 0.10, outputPer1M: 0.30, contextWindow: "128K", notes: "Fast and cheap. Good for simple tasks." },
    { model: "mistral-large-latest", label: "Mistral Large", tier: "standard", inputPer1M: 2.00, outputPer1M: 6.00, contextWindow: "128K", notes: "Strong coding. Le Chat alternative." },
  ],
  kimi: [
    { model: "kimi-for-coding", label: "Kimi Coding", tier: "standard", inputPer1M: 0.60, outputPer1M: 3.00, contextWindow: "256K", notes: "Specialized for coding. Requires User-Agent." },
  ],
  qwen: [
    { model: "qwen-turbo", label: "Qwen Turbo", tier: "budget", inputPer1M: 0.10, outputPer1M: 0.30, contextWindow: "128K", notes: "Fast, cheap. DashScope international." },
    { model: "qwen-max", label: "Qwen Max", tier: "standard", inputPer1M: 0.80, outputPer1M: 2.00, contextWindow: "128K", notes: "Top Qwen model. Good multilingual." },
  ],
  minimax: [
    { model: "MiniMax-M2.5", label: "MiniMax M2.5", tier: "standard", inputPer1M: 0.50, outputPer1M: 1.50, contextWindow: "256K", notes: "Thinking mode. Good reasoning." },
  ],
  together: [
    { model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", label: "Llama 4 Maverick", tier: "budget", inputPer1M: 0.27, outputPer1M: 0.85, contextWindow: "1M", notes: "Open model, 1M context. Good value." },
    { model: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1 (Together)", tier: "standard", inputPer1M: 3.00, outputPer1M: 7.00, contextWindow: "128K", notes: "R1 reasoning via Together. More expensive than direct." },
  ],
  fireworks: [
    { model: "accounts/fireworks/models/llama4-maverick-instruct-basic", label: "Llama 4 Maverick", tier: "budget", inputPer1M: 0.22, outputPer1M: 0.88, contextWindow: "1M", notes: "Fast Fireworks inference. Competitive pricing." },
  ],
};

/**
 * Resolve a preset name to its full configuration.
 * Returns undefined if the name is not a valid preset.
 */
export function getPreset(name: string): SystemPreset | undefined {
  return SYSTEM_PRESETS[name as PresetName];
}

/**
 * List all available presets with brief descriptions.
 */
export function listPresets(): Array<{ name: string; label: string; cost: string; description: string }> {
  return Object.values(SYSTEM_PRESETS).map((p) => ({
    name: p.name,
    label: p.label,
    cost: p.estimatedMonthlyCost,
    description: p.description,
  }));
}

/**
 * Get model options for a specific provider.
 */
export function getProviderModels(providerName: string) {
  return PROVIDER_MODEL_OPTIONS[providerName] ?? [];
}
