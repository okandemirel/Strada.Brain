import type { ToolDefinition } from "./provider.interface.js";

/**
 * Convert tool definitions to the OpenAI-compatible function calling format.
 * Shared by OpenAI, Ollama, and other compatible providers.
 */
export function convertToolDefinitions(tools: ToolDefinition[]) {
  return tools.length > 0
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    : undefined;
}
