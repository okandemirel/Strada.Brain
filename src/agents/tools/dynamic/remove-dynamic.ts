// ---------------------------------------------------------------------------
// remove_dynamic_tool — Unregister a dynamically created tool.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { DynamicToolFactory } from "./dynamic-tool-factory.js";
import { getFactory } from "./create-tool.js";

/** Resolve the factory to use: per-orchestrator from context, or the default singleton. */
function resolveFactory(context: ToolContext): DynamicToolFactory {
  if (context.dynamicToolFactory instanceof DynamicToolFactory) {
    return context.dynamicToolFactory;
  }
  return getFactory();
}

export class RemoveDynamicToolTool implements ITool {
  readonly name = "remove_dynamic_tool";
  readonly description =
    "Remove a dynamically created tool. The tool will no longer be available for use.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      tool_name: {
        type: "string",
        description:
          "The full name of the dynamic tool to remove (including the 'dynamic_' prefix).",
      },
    },
    required: ["tool_name"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const toolName = String(input["tool_name"] ?? "").trim();

    if (!toolName) {
      return { content: "Error: tool_name is required.", isError: true };
    }

    if (!toolName.startsWith("dynamic_")) {
      return {
        content: `Cannot remove '${toolName}': only dynamic tools (prefixed with 'dynamic_') can be removed.`,
        isError: true,
      };
    }

    const factory = resolveFactory(context);
    const record = factory.getRecord(toolName);
    if (!record) {
      return {
        content: `Dynamic tool '${toolName}' not found. Use create_tool to see available dynamic tools.`,
        isError: true,
      };
    }

    // Remove from factory registry
    factory.remove(toolName);

    // Remove from orchestrator via context callback
    if (context.unregisterDynamicTool) {
      const removed = context.unregisterDynamicTool(toolName);
      if (!removed) {
        return {
          content: `Tool '${toolName}' removed from dynamic registry but was not found in the orchestrator.`,
        };
      }
    }

    return {
      content:
        `Tool '${toolName}' has been removed.\n` +
        `It was called ${record.callCount} time(s) since creation at ${record.registeredAt.toISOString()}.`,
    };
  }
}
