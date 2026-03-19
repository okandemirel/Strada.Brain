import { inspectOpenAiSubscriptionAuth } from "../common/openai-subscription-auth.js";
import {
  createProvider,
  PROVIDER_PRESETS,
  type ProviderCredential,
  type ProviderCredentialMap,
} from "../agents/providers/provider-registry.js";

export interface ResponseProviderPreflightFailure {
  providerId: string;
  providerName: string;
  detail: string;
}

export interface ResponseProviderPreflightResult {
  passedProviderIds: string[];
  failures: ResponseProviderPreflightFailure[];
}

function getProviderLabel(providerId: string): string {
  if (providerId === "claude" || providerId === "anthropic") return "Claude";
  if (providerId === "ollama") return "Ollama";
  return PROVIDER_PRESETS[providerId]?.label ?? providerId;
}

function isOpenAiSubscriptionCredential(credential?: ProviderCredential): boolean {
  return credential?.openaiAuthMode === "chatgpt-subscription"
    || Boolean(credential?.openaiSubscriptionAccessToken && credential?.openaiSubscriptionAccountId)
    || Boolean(credential?.openaiChatgptAuthFile);
}

function getOpenAiSubscriptionFailureDetail(credential?: ProviderCredential): string {
  const inspection = inspectOpenAiSubscriptionAuth({
    authFile: credential?.openaiChatgptAuthFile,
    accessToken: credential?.openaiSubscriptionAccessToken,
    accountId: credential?.openaiSubscriptionAccountId,
    env: process.env,
  });
  if (!inspection.ok) {
    return `${inspection.detail} Sign in again on this machine or switch OpenAI to API-key mode.`;
  }
  return "OpenAI ChatGPT/Codex subscription health probe failed. Sign in again or switch OpenAI to API-key mode.";
}

function getGenericFailureDetail(providerId: string, providerName: string): string {
  if (providerId === "openai") {
    return `${providerName} health check failed. Verify the configured API key or subscription session.`;
  }
  return `${providerName} health check failed. Verify the credential and network access.`;
}

function getSafeFailureDetail(
  providerId: string,
  providerName: string,
  credential?: ProviderCredential,
): string {
  if (providerId === "openai" && isOpenAiSubscriptionCredential(credential)) {
    return getOpenAiSubscriptionFailureDetail(credential);
  }

  return getGenericFailureDetail(providerId, providerName);
}

export function formatProviderPreflightFailures(
  failures: ResponseProviderPreflightFailure[],
): string {
  return failures
    .map((failure) => `${failure.providerName}: ${failure.detail}`)
    .join(" ");
}

export async function preflightResponseProviders(
  providerNames: string[],
  credentials: ProviderCredentialMap,
  models?: Record<string, string>,
): Promise<ResponseProviderPreflightResult> {
  const seen = new Set<string>();
  const normalizedNames = providerNames
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => {
      if (!provider || seen.has(provider)) {
        return false;
      }
      seen.add(provider);
      return true;
    });

  const passedProviderIds: string[] = [];
  const failures: ResponseProviderPreflightFailure[] = [];

  for (const providerId of normalizedNames) {
    const credential = credentials[providerId];
    const providerName = getProviderLabel(providerId);

    try {
      const provider = createProvider({
        name: providerId,
        apiKey: credential?.apiKey,
        openaiAuthMode: credential?.openaiAuthMode,
        openaiChatgptAuthFile: credential?.openaiChatgptAuthFile,
        openaiSubscriptionAccessToken: credential?.openaiSubscriptionAccessToken,
        openaiSubscriptionAccountId: credential?.openaiSubscriptionAccountId,
        model: models?.[providerId],
      });

      const healthy = provider.healthCheck ? await provider.healthCheck() : true;
      if (healthy) {
        passedProviderIds.push(providerId);
        continue;
      }

      failures.push({
        providerId,
        providerName: provider.name,
        detail: getSafeFailureDetail(providerId, provider.name, credential),
      });
    } catch (_error) {
      failures.push({
        providerId,
        providerName,
        detail: getSafeFailureDetail(providerId, providerName, credential),
      });
    }
  }

  return {
    passedProviderIds,
    failures,
  };
}
