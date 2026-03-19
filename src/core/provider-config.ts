import type { Config } from "../config/config.js";
import { collectApiKeys } from "../rag/embeddings/embedding-resolver.js";
import type { ProviderCredentialMap } from "../agents/providers/provider-registry.js";

export function normalizeProviderNames(providerChain?: string): string[] {
  if (!providerChain) return [];
  const seen = new Set<string>();
  const names: string[] = [];

  for (const rawName of providerChain.split(",")) {
    const normalized = rawName.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(normalized);
  }

  return names;
}

export function hasUsableProviderConfig(
  name: string,
  apiKeys: Record<string, string | undefined>,
): boolean {
  if (name === "ollama") return true;
  if (name === "claude" || name === "anthropic") {
    return !!(apiKeys["claude"] || apiKeys["anthropic"]);
  }
  return !!apiKeys[name];
}

export function collectProviderCredentials(config: Config): ProviderCredentialMap {
  return {
    claude: { apiKey: config.anthropicApiKey },
    anthropic: { apiKey: config.anthropicApiKey },
    openai: {
      apiKey: config.openaiApiKey,
      openaiAuthMode: config.openaiAuthMode,
      openaiChatgptAuthFile: config.openaiChatgptAuthFile,
      openaiSubscriptionAccessToken: config.openaiSubscriptionAccessToken,
      openaiSubscriptionAccountId: config.openaiSubscriptionAccountId,
    },
    deepseek: { apiKey: config.deepseekApiKey },
    qwen: { apiKey: config.qwenApiKey },
    kimi: { apiKey: config.kimiApiKey },
    minimax: { apiKey: config.minimaxApiKey },
    groq: { apiKey: config.groqApiKey },
    mistral: { apiKey: config.mistralApiKey },
    together: { apiKey: config.togetherApiKey },
    fireworks: { apiKey: config.fireworksApiKey },
    gemini: { apiKey: config.geminiApiKey },
  };
}

export function hasConfiguredOpenAISubscription(config: Config): boolean {
  return config.openaiAuthMode === "chatgpt-subscription"
    || Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId)
    || Boolean(config.openaiChatgptAuthFile);
}

export function detectConfiguredProviderNames(
  apiKeys: Record<string, string | undefined>,
): string[] {
  const names: string[] = [];

  if (apiKeys["claude"] || apiKeys["anthropic"]) {
    names.push("claude");
  }

  for (const name of [
    "openai",
    "deepseek",
    "qwen",
    "kimi",
    "minimax",
    "groq",
    "mistral",
    "together",
    "fireworks",
    "gemini",
  ]) {
    if (apiKeys[name]) {
      names.push(name);
    }
  }

  return names;
}

export function detectConfiguredResponseProviders(config: Config): string[] {
  const apiKeys = collectApiKeys(config);
  const detectedNames = detectConfiguredProviderNames(apiKeys);

  if (hasConfiguredOpenAISubscription(config) && !detectedNames.includes("openai")) {
    detectedNames.unshift("openai");
  }

  return detectedNames;
}
