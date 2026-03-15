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
    // Aggregate capabilities - use primary provider's limits where sensible
    this.capabilities = {
      maxTokens: providers[0]!.capabilities.maxTokens,
      streaming: providers.some((p) => p.capabilities.streaming),
      structuredStreaming: providers.some((p) => p.capabilities.structuredStreaming),
      toolCalling: providers.every((p) => p.capabilities.toolCalling),
      vision: providers.some((p) => p.capabilities.vision),
      systemPrompt: providers.every((p) => p.capabilities.systemPrompt),
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
    const logger = getLogger();

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        const safeMessages = this.stripImages(messages, provider);
        const response = await provider.chat(systemPrompt, safeMessages, tools);
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
        const safeMessages = this.stripImages(messages, provider);
        // Use streaming if available, fall back to non-streaming
        if (supportsStreaming(provider)) {
          return await provider.chatStream(systemPrompt, safeMessages, tools, onChunk);
        }
        return await provider.chat(systemPrompt, safeMessages, tools);
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
