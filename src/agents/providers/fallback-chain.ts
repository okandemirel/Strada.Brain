import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  StreamCallback,
  ProviderCapabilities,
  IStreamingProvider,
} from "./provider.interface.js";
import { supportsStreaming } from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";

/**
 * Provider that chains multiple AI providers with automatic fallback.
 *
 * Tries providers in order. If one fails, falls through to the next.
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
    // Aggregate capabilities - conservative approach
    this.capabilities = {
      maxTokens: Math.min(...providers.map((p) => p.capabilities.maxTokens)),
      streaming: providers.some((p) => p.capabilities.streaming),
      structuredStreaming: providers.some((p) => p.capabilities.structuredStreaming),
      toolCalling: providers.every((p) => p.capabilities.toolCalling),
      vision: providers.some((p) => p.capabilities.vision),
      systemPrompt: providers.every((p) => p.capabilities.systemPrompt),
    };
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        const response = await provider.chat(systemPrompt, messages, tools);
        if (i > 0) {
          logger.info("Fallback provider succeeded", {
            provider: provider.name,
            attempt: i + 1,
          });
        }
        return response;
      } catch (error) {
        const isLast = i === this.providers.length - 1;
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (isLast) {
          logger.error("All providers failed", {
            provider: provider.name,
            error: errorMsg,
            totalProviders: this.providers.length,
          });
          throw error;
        }

        logger.warn("Provider failed, trying next", {
          failedProvider: provider.name,
          nextProvider: this.providers[i + 1]!.name,
          error: errorMsg,
        });
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error("No providers available");
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        // Use streaming if available, fall back to non-streaming
        if (supportsStreaming(provider)) {
          return await provider.chatStream(systemPrompt, messages, tools, onChunk);
        }
        return await provider.chat(systemPrompt, messages, tools);
      } catch (error) {
        const isLast = i === this.providers.length - 1;
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (isLast) {
          logger.error("All providers failed (streaming)", {
            provider: provider.name,
            error: errorMsg,
          });
          throw error;
        }

        logger.warn("Provider failed (streaming), trying next", {
          failedProvider: provider.name,
          nextProvider: this.providers[i + 1]!.name,
          error: errorMsg,
        });
      }
    }

    throw new Error("No providers available");
  }
}
