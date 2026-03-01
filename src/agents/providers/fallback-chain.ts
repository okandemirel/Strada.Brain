import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
} from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";

/**
 * Provider that chains multiple AI providers with automatic fallback.
 *
 * Tries providers in order. If one fails, falls through to the next.
 * Logs each attempt and failure for observability.
 */
export class FallbackChainProvider implements IAIProvider {
  readonly name: string;
  private readonly providers: IAIProvider[];

  constructor(providers: IAIProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackChainProvider requires at least one provider");
    }
    this.providers = providers;
    this.name = `chain(${providers.map((p) => p.name).join("→")})`;
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
}
