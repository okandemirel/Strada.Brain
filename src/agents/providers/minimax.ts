import type {
  ConversationMessage,
  ProviderResponse,
  ToolCall,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";
import { stripReasoningBlocks, OPENAI_STOP_REASON_MAP } from "./openai.js";
import { getLoggerSafe } from "../../utils/logger.js";

/**
 * MiniMax extends the OpenAI response with reasoning_details.
 */
interface MiniMaxResponse {
  choices: Array<{
    message: {
      content: string | null;
      reasoning_details?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        [key: string]: unknown;
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
}

/**
 * MiniMax provider.
 *
 * Handles MiniMax-specific API features:
 * - reasoning_details extraction (thinking/reasoning content from current M2.x models)
 * - Temperature must be in (0.0, 1.0] range
 * - Unsupported params: presence_penalty, frequency_penalty, logit_bias, n>1
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
const MODEL_SPECS: Record<string, { contextWindow: number; maxTokens: number }> = {
  "MiniMax-M2.7":           { contextWindow: 204_800, maxTokens: 131_072 },
  "MiniMax-M2.7-highspeed": { contextWindow: 204_800, maxTokens: 131_072 },
  "MiniMax-M2.5":           { contextWindow: 196_608, maxTokens: 65_536 },
  "MiniMax-M2.5-highspeed": { contextWindow: 196_608, maxTokens: 65_536 },
};

const DEFAULT_SPEC = MODEL_SPECS["MiniMax-M2.7"]!;

export class MiniMaxProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities;
  private inThinkBlock = false;

  constructor(
    apiKey: string,
    model = "MiniMax-M2.7",
    baseUrl = "https://api.minimax.io/v1",
  ) {
    super(apiKey, model, baseUrl, "MiniMax");
    const spec = MODEL_SPECS[model] ?? DEFAULT_SPEC;
    this.capabilities = {
      maxTokens: spec.maxTokens,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: spec.contextWindow,
      thinkingSupported: true,
      specialFeatures: ["reasoning_details"],
    };
  }

  protected override buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result = super.buildMessages(systemPrompt, messages);

    // MiniMax M2.5 reasoning_details must not be sent back in subsequent requests.
    stripReasoningBlocks(result);

    return result;
  }

  /**
   * MiniMax M2.7 embeds `<think>` blocks inside delta.content.
   * Suppress them from the user-visible stream; route to reasoning instead.
   */
  /**
   * Compute think-block state transition for the current delta without
   * mutating `inThinkBlock` yet. Both extract methods read the pre-transition
   * state; mutation happens once at the end of extractStreamText.
   */
  protected override extractStreamText(delta: Record<string, unknown> | undefined): string | undefined {
    const text = (delta?.content as string) || undefined;
    if (!text) return undefined;

    const wasInThink = this.inThinkBlock;
    const opensThink = text.includes("<think>");
    const closesThink = text.includes("</think>");

    // Update state for next delta
    if (opensThink) this.inThinkBlock = true;
    if (closesThink) this.inThinkBlock = false;

    // Suppress everything inside or on the boundary of a think block
    if (wasInThink && !closesThink) return undefined;
    if (opensThink) return undefined;

    // Closing tag mid-chunk — extract visible text after </think>
    if (closesThink) {
      const afterClose = text.split("</think>").pop()?.trim();
      return afterClose || undefined;
    }

    return text;
  }

  /**
   * MiniMax M2.x streams reasoning via `reasoning_details` delta field
   * AND via `<think>` blocks in content. Both reset the stall guard.
   */
  protected override extractStreamReasoning(delta: Record<string, unknown> | undefined): string | undefined {
    // reasoning_details field (older path)
    const details = (delta?.reasoning_details as string) || undefined;
    if (details) return details;

    // <think> content inside delta.content (M2.7 path)
    // inThinkBlock is already updated by extractStreamText (called first),
    // so check both current state and content for think markers
    const text = (delta?.content as string) || undefined;
    if (!text) return undefined;
    if (this.inThinkBlock || text.includes("<think>")) return text;

    return undefined;
  }

  /**
   * MiniMax does not expose a /models endpoint (returns 404).
   */
  override async healthCheck(): Promise<boolean> {
    const logger = getLoggerSafe();
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: await this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        await response.body?.cancel();
        return true;
      }
      logger.warn(`${this.name} health check failed: HTTP ${response.status}`);
      return false;
    } catch (err) {
      logger.warn(`${this.name} health check failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const mmData = data as unknown as MiniMaxResponse;
    const choice = mmData.choices[0];
    if (!choice) throw new Error("MiniMax returned empty choices");

    const message = choice.message;
    const reasoning = message.reasoning_details;
    const content = message.content ?? "";

    // Prepend reasoning details when present (M2.5 thinking mode)
    const text = reasoning
      ? `<reasoning>\n${reasoning}\n</reasoning>\n\n${content}`
      : content;

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let input: import("../../types/index.js").JsonObject;
      try {
        input = JSON.parse(tc.function.arguments) as import("../../types/index.js").JsonObject;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }
      return { id: tc.id, name: tc.function.name, input };
    });

    const stopReason = OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? "end_turn";

    const usage = mmData.usage;
    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
      },
    };
  }
}
