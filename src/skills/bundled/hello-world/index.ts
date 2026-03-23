// ---------------------------------------------------------------------------
// Hello World bundled skill — minimal echo tool for testing.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";

const echoTool: ITool = {
  name: "echo",
  description: "Echo back the provided message (test skill).",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "The message to echo back",
      },
    },
    required: ["message"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const message = typeof input["message"] === "string" ? input["message"] : "";
    return {
      content: `Echo: ${message}`,
    };
  },
};

export const tools = [echoTool];
export default tools;
