import { createHash } from "node:crypto";
import type {
  ConversationMessage,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIMessage } from "./openai.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A Mistral-legal tool-call id: kept when already legal, else 9 base62 chars of its hash. */
export function toMistralToolId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/u.test(id)) return id;
  const digest = createHash("sha256").update(id).digest();
  let out = "";
  for (let i = 0; i < 9; i++) out += BASE62[digest[i]! % 62];
  return out;
}

/**
 * Mistral provider.
 *
 * Handles Mistral-specific API features:
 * - safe_prompt: Injects safety system prompt for content moderation (default: false)
 * - random_seed: Enables deterministic outputs for testing/evals
 *
 * @see https://docs.mistral.ai/api/endpoint/chat
 */
export class MistralProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
    contextWindow: 262_000,
    thinkingSupported: false,
    specialFeatures: ["safe_prompt", "code_generation"],
  };

  constructor(
    apiKey: string,
    model = "mistral-large-latest",
    baseUrl = "https://api.mistral.ai/v1",
  ) {
    super(apiKey, model, baseUrl, "Mistral");
  }

  /**
   * Mistral rejects any tool-call id that is not exactly nine alphanumerics
   * ("Tool call id was … but must be a-z, A-Z, 0-9, with a length of 9"), so a
   * history carrying another provider's ids (call_…, toolu_…, functions.x:0)
   * 400'd on failover. Foreign ids are mapped deterministically, on the call
   * and on its result alike, so pairs stay matched.
   */
  protected override buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const built = super.buildMessages(systemPrompt, messages);
    return built.map((msg) => {
      const m = msg as { tool_calls?: Array<{ id: string }>; tool_call_id?: string };
      if (Array.isArray(m.tool_calls)) {
        return { ...msg, tool_calls: m.tool_calls.map((tc) => ({ ...tc, id: toMistralToolId(tc.id) })) } as OpenAIMessage;
      }
      if (typeof m.tool_call_id === "string") {
        return { ...msg, tool_call_id: toMistralToolId(m.tool_call_id) } as OpenAIMessage;
      }
      return msg;
    });
  }

  protected override buildRequestBody(
    messages: OpenAIMessage[],
    tools: unknown,
  ): Record<string, unknown> {
    const body = super.buildRequestBody(messages, tools);
    // Mistral's safe_prompt prepends a safety system prompt for content moderation.
    // Default to false to preserve the user's system prompt unchanged.
    body["safe_prompt"] = false;
    return body;
  }
}
