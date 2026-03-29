// ---------------------------------------------------------------------------
// create_tool — Dynamically create and register a new tool at runtime.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { DynamicToolFactory } from "./dynamic-tool-factory.js";
import type { DynamicToolSpec } from "./types.js";

/** Shared factory instance — tracks all dynamic tools created in this process. */
const factory = new DynamicToolFactory();

/** Expose the factory for testing and for remove_dynamic_tool. */
export function getFactory(): DynamicToolFactory {
  return factory;
}

export class CreateToolTool implements ITool {
  readonly name = "create_tool";
  readonly description =
    "Create a new tool at runtime. Use 'shell' strategy to wrap CLI commands, " +
    "or 'composite' strategy to chain existing tools. The new tool becomes " +
    "available immediately for use in subsequent actions.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description:
          "Tool name (lowercase, [a-z0-9_]). Will be prefixed with 'dynamic_'.",
      },
      description: {
        type: "string",
        description: "What this tool does. Shown to the LLM for function selection.",
      },
      strategy: {
        type: "string",
        enum: ["shell", "composite"],
        description:
          "'shell' — wraps a CLI command with {{param}} interpolation. " +
          "'composite' — chains existing tools in sequence.",
      },
      parameters: {
        type: "array",
        description: "Input parameters for the new tool.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Parameter name" },
            type: { type: "string", description: "JSON Schema type (string, number, boolean, array, object)" },
            description: { type: "string", description: "What this parameter is for" },
            required: { type: "boolean", description: "Whether the parameter is required (default true)" },
          },
        },
      },
      command: {
        type: "string",
        description:
          "[Shell strategy] Command template with {{paramName}} placeholders. " +
          "Example: 'git log --oneline -n {{count}}'",
      },
      timeout: {
        type: "number",
        description: "[Shell strategy] Timeout in ms (default 30000, max 60000).",
      },
      steps: {
        type: "array",
        description: "[Composite strategy] Ordered list of tool calls.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Name of existing tool to call" },
            params: {
              type: "object",
              description: "Parameter mapping — values can be literals or {{paramRef}}",
            },
            outputAs: {
              type: "string",
              description: "Name to reference this step's output in later steps",
            },
          },
        },
      },
    },
    required: ["name", "description", "strategy"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // Check that the orchestrator provided the dynamic registration callback
    if (!context.registerDynamicTool) {
      return {
        content:
          "Dynamic tool creation is not available in this context. " +
          "The orchestrator must provide registerDynamicTool in ToolContext.",
        isError: true,
      };
    }

    // Build spec from input
    const spec: DynamicToolSpec = {
      name: String(input["name"] ?? ""),
      description: String(input["description"] ?? ""),
      strategy: String(input["strategy"] ?? "shell") as DynamicToolSpec["strategy"],
      parameters: (input["parameters"] as DynamicToolSpec["parameters"]) ?? [],
      command: input["command"] as string | undefined,
      timeout: input["timeout"] as number | undefined,
      steps: input["steps"] as DynamicToolSpec["steps"],
    };

    // Create the tool via factory (factory checks for duplicates internally)
    const prefixedName = `dynamic_${spec.name}`;
    let tool: ITool;
    try {
      tool = factory.create(
        spec,
        new Set<string>(),
        context.lookupTool,
      );
    } catch (err) {
      return {
        content: `Failed to create tool: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // Register in orchestrator
    try {
      context.registerDynamicTool(tool);
    } catch (err) {
      factory.remove(prefixedName);
      return {
        content: `Tool created but registration failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const paramList =
      spec.parameters.length > 0
        ? spec.parameters.map((p) => `  - ${p.name} (${p.type})${p.required !== false ? " *required*" : ""}`).join("\n")
        : "  (no parameters)";

    return {
      content:
        `Tool '${prefixedName}' created and registered.\n\n` +
        `Strategy: ${spec.strategy}\n` +
        `Parameters:\n${paramList}\n\n` +
        `You can now call '${prefixedName}' as a regular tool.`,
    };
  }
}
