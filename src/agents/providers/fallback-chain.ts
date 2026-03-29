import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  StreamCallback,
  ProviderCapabilities,
  IStreamingProvider,
} from "./provider.interface.js";
import type { MessageContent } from "./provider-core.interface.js";
import { supportsStreaming } from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";

/**
 * Check whether a provider error is likely caused by the request itself
 * (e.g., malformed tool_calls, invalid schema) rather than a transient
 * provider issue. Non-retryable errors should NOT fall through to the
 * next provider because they would fail identically.
 */
/** Regex for provider-specific reasoning protocol errors that should fall through */
const REASONING_CONTENT_RE = /reasoning_content/i;
/** Regex for HTTP 400 errors caused by malformed request body or schema */
const BAD_REQUEST_RE = /bad.?request|invalid|malformed/i;
/** Regex for quota/rate-limit 403 errors that can be resolved by switching provider */
const QUOTA_LIMIT_RE = /quota|limit|billing|cycle|exceeded|usage/i;
/** Regex for invalid tool/schema errors */
const INVALID_TOOL_RE = /invalid.*tool|tool.*invalid|invalid.*schema/i;

function isNonRetryableRequestError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (REASONING_CONTENT_RE.test(msg)) return false;
  if (/\b400\b/.test(msg) && BAD_REQUEST_RE.test(msg)) return true;
  if (/\b403\b/.test(msg) && QUOTA_LIMIT_RE.test(msg)) return false;
  if (/\b40[13]\b/.test(msg)) return true;
  if (INVALID_TOOL_RE.test(msg)) return true;
  return false;
}

/**
 * Provider that chains multiple AI providers with automatic fallback.
 *
 * Tries providers in order. If one fails, falls through to the next.
 * Non-retryable errors (400 bad request, auth failures) are re-thrown
 * immediately without trying subsequent providers.
 * Logs each attempt and failure for observability.
 */
export class FallbackChainProvider implements IAIProvider, IStreamingProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly providers: IAIProvider[];

  constructor(providers: IAIProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackChainProvider requires at least one provider");
    }
    this.providers = providers;
    this.name = `chain(${providers.map((p) => p.name).join("→")})`;
    // Aggregate capabilities - use primary provider's limits where sensible
    this.capabilities = {
      maxTokens: providers[0]!.capabilities.maxTokens,
      streaming: providers.some((p) => p.capabilities.streaming),
      structuredStreaming: providers.some((p) => p.capabilities.structuredStreaming),
      toolCalling: providers.every((p) => p.capabilities.toolCalling),
      vision: providers.some((p) => p.capabilities.vision),
      systemPrompt: providers.every((p) => p.capabilities.systemPrompt),
      contextWindow: Math.max(...providers.map(p => p.capabilities.contextWindow ?? 0)),
      thinkingSupported: providers.some(p => p.capabilities.thinkingSupported),
      specialFeatures: [...new Set(providers.flatMap(p => p.capabilities.specialFeatures ?? []))],
    };
  }

  /**
   * Strip image content blocks from messages when the target provider
   * doesn't support vision. Text-only content is preserved as-is.
   */
  private stripImages(
    messages: ConversationMessage[],
    provider: IAIProvider
  ): ConversationMessage[] {
    if (provider.capabilities.vision) return messages;

    return messages.map((msg) => {
      if (msg.role !== "user" || typeof msg.content === "string") return msg;
      const filtered = (msg.content as MessageContent[]).filter(
        (block) => block.type !== "image"
      );
      // If all blocks were images, replace with a placeholder so the message isn't empty
      if (filtered.length === 0) {
        return { ...msg, content: "[image removed — provider does not support vision]" };
      }
      // If only text remains, collapse to plain string for simplicity
      if (filtered.length === 1 && filtered[0]!.type === "text") {
        return { ...msg, content: filtered[0]!.text };
      }
      return { ...msg, content: filtered };
    }) as ConversationMessage[];
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("chat", (provider, safeMessages) =>
      provider.chat(systemPrompt, safeMessages, tools),
      messages,
    );
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<ProviderResponse> {
    return this.tryWithFallback("streaming", (provider, safeMessages) => {
      if (supportsStreaming(provider)) {
        return provider.chatStream(systemPrompt, safeMessages, tools, onChunk);
      }
      return provider.chat(systemPrompt, safeMessages, tools);
    }, messages);
  }

  async healthCheck(): Promise<boolean> {
    for (const provider of this.providers) {
      if (!provider.healthCheck) {
        return true;
      }
      try {
        if (await provider.healthCheck()) {
          return true;
        }
      } catch {
        // Try the next provider in the chain.
      }
    }
    return false;
  }

  async listModels(): Promise<string[]> {
    for (const provider of this.providers) {
      if (!provider.listModels) {
        continue;
      }
      try {
        const models = await provider.listModels();
        if (models.length > 0) {
          return models;
        }
      } catch {
        // Try the next provider in the chain.
      }
    }
    return [];
  }

  /**
   * Try each provider in order, falling back on transient errors.
   * Non-retryable errors (400, auth) are re-thrown immediately.
   */
  private async tryWithFallback(
    label: string,
    attempt: (provider: IAIProvider & Partial<IStreamingProvider>, messages: ConversationMessage[]) => Promise<ProviderResponse>,
    messages: ConversationMessage[],
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        const safeMessages = this.stripImages(messages, provider);
        const response = await attempt(provider, safeMessages);
        if (i > 0) {
          logger.info("Fallback provider succeeded", {
            provider: provider.name,
            attempt: i + 1,
          });
        }
        return response;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (isNonRetryableRequestError(error)) {
          logger.error(`Non-retryable provider error (${label}), not trying fallbacks`, {
            provider: provider.name,
            error: errorMsg,
          });
          throw error;
        }

        const isLast = i === this.providers.length - 1;
        if (isLast) {
          logger.error(`All providers failed (${label})`, {
            provider: provider.name,
            error: errorMsg,
            totalProviders: this.providers.length,
          });
          throw new Error(`All providers failed. Last error: ${errorMsg}`);
        }

        logger.warn(`Provider failed (${label}), trying next`, {
          failedProvider: provider.name,
          nextProvider: this.providers[i + 1]!.name,
          error: errorMsg,
        });
      }
    }

    throw new Error("All providers failed");
  }
}
