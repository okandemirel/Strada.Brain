import { inspectClaudeSubscriptionAuth } from "../common/claude-subscription-auth.js";
import { inspectOpenAiSubscriptionAuth } from "../common/openai-subscription-auth.js";
import {
  createProvider,
  PROVIDER_PRESETS,
  type ProviderCredential,
  type ProviderCredentialMap,
} from "../agents/providers/provider-registry.js";
import { codexSubscriptionProbeFailureMessage } from "../agents/providers/codex-model-rejection.js";

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

function isClaudeSubscriptionCredential(credential?: ProviderCredential): boolean {
  return credential?.anthropicAuthMode === "claude-subscription"
    && Boolean(credential?.anthropicAuthToken);
}

function getClaudeSubscriptionFailureDetail(credential?: ProviderCredential): string {
  const inspection = inspectClaudeSubscriptionAuth({
    authToken: credential?.anthropicAuthToken,
    env: process.env,
  });
  if (!inspection.ok) {
    return inspection.detail;
  }
  return "Claude subscription health probe failed. Generate a new Claude auth token or switch Claude to API-key mode.";
}

function getOpenAiSubscriptionFailureDetail(
  credential?: ProviderCredential,
  provider?: { getLastHealthDetail?: () => string | undefined },
): string {
  // Prefer the real reason captured by the live health probe (e.g. "the configured
  // model is not accepted by the Codex endpoint") so we never misdiagnose a model
  // mismatch as an auth problem.
  const probeDetail = provider?.getLastHealthDetail?.();
  if (probeDetail) {
    return probeDetail;
  }
  const inspection = inspectOpenAiSubscriptionAuth({
    authFile: credential?.openaiChatgptAuthFile,
    accessToken: credential?.openaiSubscriptionAccessToken,
    accountId: credential?.openaiSubscriptionAccountId,
    env: process.env,
  });
  if (!inspection.ok) {
    return `${inspection.detail} Sign in again on this machine or switch OpenAI to API-key mode.`;
  }
  return codexSubscriptionProbeFailureMessage();
}

function getGenericFailureDetail(providerId: string, providerName: string): string {
  if (providerId === "claude" || providerId === "anthropic") {
    return `${providerName} health check failed. Verify the API key or Claude auth token and network access.`;
  }
  if (providerId === "openai") {
    return `${providerName} health check failed. Verify the configured API key or subscription session.`;
  }
  return `${providerName} health check failed. Verify the credential and network access.`;
}

function getSafeFailureDetail(
  providerId: string,
  providerName: string,
  credential?: ProviderCredential,
  provider?: { getLastHealthDetail?: () => string | undefined },
): string {
  if ((providerId === "claude" || providerId === "anthropic") && isClaudeSubscriptionCredential(credential)) {
    return getClaudeSubscriptionFailureDetail(credential);
  }

  if (providerId === "openai" && isOpenAiSubscriptionCredential(credential)) {
    return getOpenAiSubscriptionFailureDetail(credential, provider);
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
  baseUrls?: Record<string, string>,
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

    // Throwaway provider instances are created purely to run healthCheck(). They
    // must be released after the probe so any future provider that holds a
    // long-lived handle (socket/timer) does not leak across preflight. Capture
    // the instance outside the try so it can be disposed in finally.
    let provider: ReturnType<typeof createProvider> | undefined;
    try {
      provider = createProvider({
        name: providerId,
        apiKey: credential?.apiKey,
        anthropicAuthMode: credential?.anthropicAuthMode,
        anthropicAuthToken: credential?.anthropicAuthToken,
        openaiAuthMode: credential?.openaiAuthMode,
        openaiChatgptAuthFile: credential?.openaiChatgptAuthFile,
        openaiSubscriptionAccessToken: credential?.openaiSubscriptionAccessToken,
        openaiSubscriptionAccountId: credential?.openaiSubscriptionAccountId,
        model: models?.[providerId],
        baseUrl: baseUrls?.[providerId],
      });

      const healthy = provider.healthCheck ? await provider.healthCheck() : true;
      if (healthy) {
        passedProviderIds.push(providerId);
        continue;
      }

      failures.push({
        providerId,
        providerName: provider.name,
        detail: getSafeFailureDetail(
          providerId,
          provider.name,
          credential,
          provider as { getLastHealthDetail?: () => string | undefined },
        ),
      });
    } catch (_error) {
      failures.push({
        providerId,
        providerName,
        detail: getSafeFailureDetail(providerId, providerName, credential),
      });
    } finally {
      const disposable = provider as
        | { dispose?: () => void | Promise<void>; close?: () => void | Promise<void> }
        | undefined;
      try {
        if (typeof disposable?.dispose === "function") {
          await disposable.dispose();
        } else if (typeof disposable?.close === "function") {
          await disposable.close();
        }
      } catch {
        // Disposal of a throwaway preflight provider must never mask the probe result.
      }
    }
  }

  return {
    passedProviderIds,
    failures,
  };
}
