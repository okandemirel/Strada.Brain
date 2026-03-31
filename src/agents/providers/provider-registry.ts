import type { IAIProvider } from "./provider.interface.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import type { AnthropicAuthMode, OpenAIAuthMode } from "../../config/config.js";
import { OllamaProvider } from "./ollama.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { GeminiProvider } from "./gemini.js";
import { DeepSeekProvider } from "./deepseek.js";
import { QwenProvider } from "./qwen.js";
import { KimiProvider } from "./kimi.js";
import { MiniMaxProvider } from "./minimax.js";
import { GroqProvider } from "./groq.js";
import { MistralProvider } from "./mistral.js";
import { TogetherProvider } from "./together.js";
import { FireworksProvider } from "./fireworks.js";
import { getLogger } from "../../utils/logger.js";

/**
 * Maps provider names to their dedicated class constructors.
 * Each class extends OpenAIProvider with provider-specific defaults.
 */
type OpenAICompatibleProviderConstructor = new (
  apiKey: string,
  model?: string,
  baseUrl?: string,
) => OpenAIProvider;

const PROVIDER_CLASS_MAP: Record<string, OpenAICompatibleProviderConstructor> = {
  gemini: GeminiProvider,
  deepseek: DeepSeekProvider,
  qwen: QwenProvider,
  kimi: KimiProvider,
  minimax: MiniMaxProvider,
  groq: GroqProvider,
  mistral: MistralProvider,
  together: TogetherProvider,
  fireworks: FireworksProvider,
};

/**
 * Known provider presets with their default base URLs and models.
 * All non-Claude/Ollama providers use the OpenAI-compatible API format.
 */
export const PROVIDER_PRESETS: Record<
  string,
  { baseUrl: string; defaultModel: string; label: string }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.2",
    label: "OpenAI",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    label: "DeepSeek",
  },
  qwen: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-max",
    label: "Qwen (Alibaba)",
  },
  kimi: {
    baseUrl: "https://api.kimi.com/coding/v1",
    defaultModel: "kimi-for-coding",
    label: "Kimi (Moonshot)",
  },
  minimax: {
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    label: "MiniMax",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    label: "Groq",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    label: "Mistral",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    label: "Together AI",
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama4-maverick-instruct-basic",
    label: "Fireworks AI",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3-flash-preview",
    label: "Google Gemini",
  },
};

/**
 * Provider configuration for the registry.
 */
export interface ProviderConfig {
  /** Provider name (must match a preset key or "claude"/"ollama") */
  name: string;
  /** API key (not needed for Ollama) */
  apiKey?: string;
  /** Anthropic auth mode */
  anthropicAuthMode?: AnthropicAuthMode;
  /** Optional long-lived Claude auth token for bearer auth */
  anthropicAuthToken?: string;
  /** OpenAI auth mode */
  openaiAuthMode?: OpenAIAuthMode;
  /** Optional local Codex auth.json path for ChatGPT/Codex subscription access */
  openaiChatgptAuthFile?: string;
  /** Optional manual ChatGPT/Codex access token override */
  openaiSubscriptionAccessToken?: string;
  /** Optional ChatGPT workspace/account id override */
  openaiSubscriptionAccountId?: string;
  /** Override model */
  model?: string;
  /** Override base URL */
  baseUrl?: string;
}

export interface ProviderCredential {
  apiKey?: string;
  anthropicAuthMode?: AnthropicAuthMode;
  anthropicAuthToken?: string;
  openaiAuthMode?: OpenAIAuthMode;
  openaiChatgptAuthFile?: string;
  openaiSubscriptionAccessToken?: string;
  openaiSubscriptionAccountId?: string;
}

export type ProviderCredentialMap = Record<string, ProviderCredential | undefined>;

function hasOpenAISubscriptionCredential(config: ProviderConfig): boolean {
  return config.openaiAuthMode === "chatgpt-subscription"
    || Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId)
    || Boolean(config.openaiChatgptAuthFile);
}

function hasAnthropicSubscriptionCredential(config: ProviderConfig): boolean {
  return config.anthropicAuthMode === "claude-subscription"
    && Boolean(config.anthropicAuthToken);
}

/**
 * Build a provider from configuration.
 */
export function createProvider(config: ProviderConfig): IAIProvider {
  const { name } = config;

  if (name === "claude" || name === "anthropic") {
    if (config.anthropicAuthMode === "claude-subscription" && !config.anthropicAuthToken) {
      throw new Error("Claude subscription auth requires ANTHROPIC_AUTH_TOKEN");
    }
    if (!config.apiKey && !hasAnthropicSubscriptionCredential(config)) {
      throw new Error("Claude provider requires an API key or Claude subscription auth token");
    }
    if (hasAnthropicSubscriptionCredential(config)) {
      return new ClaudeProvider(
        {
          mode: "claude-subscription",
          authToken: config.anthropicAuthToken!,
        },
        config.model,
      );
    }
    return new ClaudeProvider(config.apiKey!, config.model);
  }

  if (name === "ollama") {
    return new OllamaProvider(
      config.model ?? "llama3.3",
      config.baseUrl ?? "http://localhost:11434",
    );
  }

  if (name === "openai") {
    if (!config.apiKey && !hasOpenAISubscriptionCredential(config)) {
      throw new Error("OpenAI provider requires an API key or ChatGPT/Codex subscription auth");
    }
    const auth = hasOpenAISubscriptionCredential(config)
      ? {
          mode: "chatgpt-subscription" as const,
          accessToken: config.openaiSubscriptionAccessToken,
          accountId: config.openaiSubscriptionAccountId,
          authFile: config.openaiChatgptAuthFile,
        }
      : {
          mode: "api-key" as const,
          apiKey: config.apiKey!,
        };
    return new OpenAIProvider(
      auth,
      config.model ?? PROVIDER_PRESETS["openai"]!.defaultModel,
      config.baseUrl ?? PROVIDER_PRESETS["openai"]!.baseUrl,
      PROVIDER_PRESETS["openai"]!.label,
    );
  }

  // OpenAI-compatible provider (use preset or class map)
  const preset = PROVIDER_PRESETS[name];
  const baseUrl = config.baseUrl ?? preset?.baseUrl;
  const model = config.model ?? preset?.defaultModel ?? "gpt-4o";

  if (!baseUrl) {
    throw new Error(
      `Unknown provider "${name}". Available: claude, ollama, ${Object.keys(PROVIDER_PRESETS).join(", ")}`,
    );
  }

  if (!config.apiKey) {
    throw new Error(`${preset?.label ?? name} provider requires an API key`);
  }

  // Use dedicated class if available, otherwise fall back to generic OpenAIProvider
  const ProviderClass = PROVIDER_CLASS_MAP[name];
  if (ProviderClass) {
    return new ProviderClass(config.apiKey, model, baseUrl);
  }

  return new OpenAIProvider(config.apiKey, model, baseUrl, preset?.label ?? name);
}

/**
 * Build a provider chain from a comma-separated provider string.
 *
 * Format: "claude,deepseek,ollama"
 * Each provider uses its own env var for the API key:
 *   CLAUDE_API_KEY, DEEPSEEK_API_KEY, OLLAMA_BASE_URL, etc.
 *
 * Returns a single provider or a FallbackChainProvider if multiple.
 */
export function buildProviderChain(
  providerNames: string[],
  credentials: ProviderCredentialMap,
  overrides?: { models?: Record<string, string>; baseUrls?: Record<string, string> },
): IAIProvider {
  const logger = getLogger();
  const providers: IAIProvider[] = [];

  for (const name of providerNames) {
    const trimmed = name.trim().toLowerCase();
    try {
      const credential = credentials[trimmed] ?? {};
      const provider = createProvider({
        name: trimmed,
        apiKey: credential.apiKey,
        anthropicAuthMode: credential.anthropicAuthMode,
        anthropicAuthToken: credential.anthropicAuthToken,
        openaiAuthMode: credential.openaiAuthMode,
        openaiChatgptAuthFile: credential.openaiChatgptAuthFile,
        openaiSubscriptionAccessToken: credential.openaiSubscriptionAccessToken,
        openaiSubscriptionAccountId: credential.openaiSubscriptionAccountId,
        model: overrides?.models?.[trimmed],
        baseUrl: overrides?.baseUrls?.[trimmed],
      });
      providers.push(provider);

      const preset = PROVIDER_PRESETS[trimmed];
      const keyPrefix = credential.apiKey?.slice(0, 6)
        ?? (hasAnthropicSubscriptionCredential({
          name: trimmed,
          anthropicAuthMode: credential.anthropicAuthMode,
          anthropicAuthToken: credential.anthropicAuthToken,
        })
          ? "(subscription)"
          : undefined)
        ?? (hasOpenAISubscriptionCredential({
          name: trimmed,
          openaiAuthMode: credential.openaiAuthMode,
          openaiChatgptAuthFile: credential.openaiChatgptAuthFile,
          openaiSubscriptionAccessToken: credential.openaiSubscriptionAccessToken,
          openaiSubscriptionAccountId: credential.openaiSubscriptionAccountId,
        })
          ? "(subscription)"
          : undefined);
      logger.info(`Provider ready: ${provider.name}`, {
        model: overrides?.models?.[trimmed] ?? preset?.defaultModel ?? "default",
        keyPrefix: keyPrefix ? `${keyPrefix}...` : "(none)",
      });
    } catch (error) {
      logger.warn(
        `Skipping provider "${trimmed}": ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (providers.length === 0) {
    throw new Error("No valid providers configured");
  }

  return new FallbackChainProvider(providers);
}
