/**
 * Ask User Tool -- Allows the agent to ask clarifying questions.
 *
 * Supports multiple-choice options with a recommended option,
 * plus free-form text input from the user.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { supportsInteractivity } from "../../channels/channel-core.interface.js";

export class AskUserTool implements ITool {
  readonly name = "ask_user";
  readonly description =
    "Ask the user a clarifying question when the request is ambiguous or you need more information before proceeding. " +
    "You can provide multiple-choice options with a recommended option, or ask an open-ended question. " +
    "The user can choose an option OR provide their own answer.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user. Be specific and concise.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional multiple-choice options. The user can pick one or write their own answer. Keep to 2-5 options.",
      },
      recommended: {
        type: "string",
        description:
          "Optional: your recommended option (must be one of the options). Helps the user decide.",
      },
      context: {
        type: "string",
        description: "Optional: brief context explaining why you are asking this question.",
      },
    },
    required: ["question"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const question = String(input["question"] ?? "").trim();
    const options = (input["options"] as string[] | undefined) ?? [];
    const recommended = input["recommended"] as string | undefined;
    const questionContext = input["context"] as string | undefined;

    if (!question) {
      return { content: "Error: question is required", isError: true };
    }

    // Enforce content limits (security: prevent LLM social engineering)
    const safeQuestion = question.slice(0, 500);
    const safeOptions = options.slice(0, 5).map((o) => String(o).slice(0, 100));
    const safeContext = questionContext?.slice(0, 200);

    // Build the message to show the user
    let message = "";

    if (safeContext) {
      message += `${safeContext}\n\n`;
    }

    message += `**${safeQuestion}**`;

    if (safeOptions.length > 0) {
      const lines = safeOptions.map((opt, i) => {
        const tag = recommended && opt === recommended ? " *(recommended)*" : "";
        return `${i + 1}. ${opt}${tag}`;
      });
      message += "\n\n" + lines.join("\n");
      message += "\n\nYou can pick an option or write your own answer.";
    }

    // Use the channel's confirmation mechanism if available
    const channel = context.channel;
    if (channel && supportsInteractivity(channel)) {
      // For multiple-choice: show options. For open-ended: don't force Yes/No.
      const confirmOptions = safeOptions.length > 0
        ? safeOptions
        : ["Continue", "Cancel"];

      const response = await channel.requestConfirmation({
        chatId: context.chatId ?? "",
        userId: context.userId,
        question: message,
        options: confirmOptions,
        details: safeContext,
      });

      if (response === "timeout") {
        return {
          content: "User did not respond within the timeout period. Proceed with your best judgment.",
        };
      }

      return { content: `User answered: ${response}` };
    }

    // Fallback: channel doesn't support interactivity
    return {
      content:
        "Unable to ask user interactively. Proceed with your best judgment based on the context available.",
    };
  }
}
