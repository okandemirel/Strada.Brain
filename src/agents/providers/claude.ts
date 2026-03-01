import Anthropic from "@anthropic-ai/sdk";
import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  ToolCall,
  StreamCallback,
} from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";

/**
 * Claude AI provider using the Anthropic SDK.
 * Primary provider for Strata Brain.
 */
export class ClaudeProvider implements IAIProvider {
  readonly name = "claude";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const anthropicMessages = this.buildMessages(messages);
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    logger.debug("Claude API call", {
      model: this.model,
      messageCount: anthropicMessages.length,
      toolCount: anthropicTools.length,
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    return this.parseResponse(response);
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const anthropicMessages = this.buildMessages(messages);
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    logger.debug("Claude streaming API call", {
      model: this.model,
      messageCount: anthropicMessages.length,
    });

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    stream.on("text", (text) => {
      onChunk(text);
    });

    const response = await stream.finalMessage();
    return this.parseResponse(response);
  }

  private buildMessages(
    messages: ConversationMessage[]
  ): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (msg.toolResults && msg.toolResults.length > 0) {
          // This is a tool result message
          const content: Anthropic.ToolResultBlockParam[] = msg.toolResults.map(
            (tr) => ({
              type: "tool_result" as const,
              tool_use_id: tr.toolCallId,
              content: tr.content,
              is_error: tr.isError,
            })
          );
          result.push({ role: "user", content });
        } else {
          result.push({ role: "user", content: msg.content });
        }
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: (
            | Anthropic.TextBlockParam
            | Anthropic.ToolUseBlockParam
          )[] = [];

          if (msg.content) {
            content.push({ type: "text", text: msg.content });
          }

          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }

          result.push({ role: "assistant", content });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }

  private parseResponse(response: Anthropic.Message): ProviderResponse {
    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const stopReason =
      response.stop_reason === "tool_use"
        ? "tool_use"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
