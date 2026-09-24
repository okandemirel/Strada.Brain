import type { AnthropicAuthMode, OpenAIAuthMode } from "../../config/config.js";
import { inspectOpenAiSubscriptionAuth } from "../../common/openai-subscription-auth.js";

/** The credential fields that decide whether a seat runs on a subscription. */
export interface SubscriptionCredentialFields {
  apiKey?: string;
  anthropicAuthMode?: AnthropicAuthMode;
  anthropicAuthToken?: string;
  openaiAuthMode?: OpenAIAuthMode;
  openaiChatgptAuthFile?: string;
  openaiSubscriptionAccessToken?: string;
  openaiSubscriptionAccountId?: string;
}

export function hasOpenAISubscriptionCredential(config: SubscriptionCredentialFields): boolean {
  return config.openaiAuthMode === "chatgpt-subscription"
    || Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId)
    || Boolean(config.openaiChatgptAuthFile);
}

export function hasAnthropicSubscriptionCredential(config: SubscriptionCredentialFields): boolean {
  return config.anthropicAuthMode === "claude-subscription"
    && Boolean(config.anthropicAuthToken);
}

/**
 * The secret a seat authenticates with, for its health-identity fingerprint
 * (ProviderHealthRegistry.seatIdentity hashes it; it is never stored raw).
 *
 * The API key, unless the seat runs on a subscription — the same precedence
 * createProvider uses. A subscription seat has no API key, so its identity read
 * "nokey" and a bench earned by a token the server later rotated survived
 * re-login and restart against the new token. Its token identifies it instead:
 * Claude's bearer token, or the ChatGPT/Codex account and access token (the
 * explicit override, else the codex auth file).
 */
export function seatCredentialSecret(
  name: string,
  credential: SubscriptionCredentialFields | undefined,
  apiKey: string | undefined,
): string | undefined {
  const config: SubscriptionCredentialFields = { ...credential, apiKey: apiKey ?? credential?.apiKey };
  if ((name === "claude" || name === "anthropic") && hasAnthropicSubscriptionCredential(config)) {
    return `claude-subscription:${config.anthropicAuthToken}`;
  }
  if (name === "openai" && hasOpenAISubscriptionCredential(config)) {
    const auth = inspectOpenAiSubscriptionAuth({
      accessToken: config.openaiSubscriptionAccessToken,
      accountId: config.openaiSubscriptionAccountId,
      authFile: config.openaiChatgptAuthFile,
    });
    return auth.accessToken ? `chatgpt-subscription:${auth.accountId ?? ""}:${auth.accessToken}` : undefined;
  }
  return config.apiKey;
}
