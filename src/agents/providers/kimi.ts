import type {
  ProviderResponse,
  ToolCall,
  ProviderCapabilities,
} from "./provider.interface.js";
import type { AssistantMessage, ConversationMessage } from "./provider-core.interface.js";
import { OpenAIProvider, OPENAI_STOP_REASON_MAP } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";

/**
 * Kimi response extends OpenAI format with reasoning_content.
 * K2.5 thinking mode returns reasoning alongside content and tool calls.
 */
interface KimiResponse {
  choices: Array<{
    message: {
      content: string | null;
      reasoning_content?: string | null;
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
 * Kimi (Moonshot) provider.
 *
 * Handles Kimi-specific API features:
 * - User-Agent whitelisting: coding endpoint only allows known agents
 * - reasoning_content: K2.5 thinking mode returns reasoning that MUST be
 *   echoed back in assistant tool call messages or API returns 400
 * - Empty reasoning_content must be omitted entirely (not sent as "")
 *
 * Base URLs:
 * - China: https://api.moonshot.cn/v1
 * - International: https://api.moonshot.ai/v1
 * - Coding: https://api.kimi.com/coding/v1
 *
 * @see https://www.kimi.com/code/docs/en/more/third-party-agents.html
 */
export class KimiProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 16384,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 262_000,
    thinkingSupported: true,
    specialFeatures: ["coding", "reasoning"],
  };

  constructor(
    apiKey: string,
    model = "kimi-for-coding",
    baseUrl = "https://api.kimi.com/coding/v1",
  ) {
    super(apiKey, model, baseUrl, "Kimi (Moonshot)");
  }

  protected override async buildHeaders(): Promise<Record<string, string>> {
    return {
      ...(await super.buildHeaders()),
      "User-Agent": "claude-code/0.1.0",
    };
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const kimiData = data as unknown as KimiResponse;
    const choice = kimiData.choices[0];
    if (!choice) throw new Error("Kimi returned empty choices");

    const message = choice.message;
    const reasoning = message.reasoning_content;
    const rawContent = message.content ?? "";
    // Embed reasoning in text for round-trip survival (buildMessages strips it)
    const content = reasoning
      ? `<reasoning>\n${reasoning}\n</reasoning>\n\n${rawContent}`
      : rawContent;

    // reasoning_content is a turn-level concept — attach only to the first tool call
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc, idx) => {
      let input: import("../../types/index.js").JsonObject;
      try {
        input = JSON.parse(tc.function.arguments) as import("../../types/index.js").JsonObject;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }
      // Store reasoning_content only on first tool call (buildMessages reads it back)
      const providerMetadata = idx === 0 && reasoning ? { reasoning_content: reasoning } : undefined;
      return providerMetadata
        ? { id: tc.id, name: tc.function.name, input, providerMetadata }
        : { id: tc.id, name: tc.function.name, input };
    });

    const stopReason = OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? "end_turn";

    const usage = kimiData.usage;
    return {
      text: content,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
      },
    };
  }

  /**
   * Kimi K2.5: only stream content to user, NOT reasoning_content (internal thinking).
   */
  protected override extractStreamText(delta: Record<string, unknown> | undefined): string | undefined {
    return (delta?.content as string) || undefined;
  }

  /**
   * Kimi K2.5: accumulate reasoning_content separately for tool call echo.
   */
  protected override extractStreamReasoning(delta: Record<string, unknown> | undefined): string | undefined {
    return (delta?.reasoning_content as string) || undefined;
  }

  protected override buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result = super.buildMessages(systemPrompt, messages);

    // Kimi K2.5: extract <reasoning> blocks from assistant text and
    // set as reasoning_content field (required when thinking is enabled).
    // Tool-call messages MUST carry reasoning_content as a non-null string
    // or the API returns 400.  Text-only messages tolerate omission.
    for (const msg of result) {
      if (msg.role === "assistant") {
        const rec = msg as unknown as Record<string, unknown>;
        if (typeof msg.content === "string") {
          const allMatches = [...msg.content.matchAll(/<reasoning>\s*([\s\S]*?)\s*<\/reasoning>/g)];
          if (allMatches.length > 0) {
            rec["reasoning_content"] = allMatches.map(m => m[1]).join("\n");
            msg.content = msg.content.replace(/<reasoning>\s*[\s\S]*?\s*<\/reasoning>\s*\n*/g, "");
            if (!msg.content.trim()) msg.content = null;
          }
        }
        // Tool-call messages: Kimi requires reasoning_content as a non-null
        // string.  Use "." as a minimal fallback when reasoning was not
        // captured (should not happen with K2.5, but defends against it).
        // Text-only messages: omit the field entirely when absent — the API
        // only validates reasoning_content on tool-call messages.
        if (rec["reasoning_content"] === undefined || rec["reasoning_content"] === null) {
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            rec["reasoning_content"] = ".";
          } else {
            delete rec["reasoning_content"];
          }
        }
      }
    }

    return result;
  }

  protected override buildAssistantToolCallMessage(msg: AssistantMessage): OpenAIMessage {
    const reasoning = msg.tool_calls
      ?.find(tc => tc.providerMetadata?.reasoning_content)
      ?.providerMetadata?.reasoning_content as string | undefined;

    const assistantMsg = super.buildAssistantToolCallMessage(msg);
    // Set reasoning if found from providerMetadata.  If absent, leave
    // undefined — the buildMessages loop will extract from <reasoning>
    // tags in content or apply the "." fallback for tool-call messages.
    if (reasoning) {
      (assistantMsg as unknown as Record<string, unknown>)["reasoning_content"] = reasoning;
    }
    return assistantMsg;
  }
}
