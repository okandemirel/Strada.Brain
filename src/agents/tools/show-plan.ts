/**
 * Show Plan Tool -- Shows the user a plan for approval before executing.
 *
 * Used for complex multi-step tasks where the user should review
 * and approve the approach before the agent proceeds.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { supportsInteractivity } from "../../channels/channel-core.interface.js";

export class ShowPlanTool implements ITool {
  readonly name = "show_plan";
  readonly description =
    "Show the user your planned approach for a complex task and wait for their approval. " +
    "Use this when a task involves multiple steps, file modifications, or architectural decisions. " +
    "The user can approve, request changes, or reject the plan.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "One-sentence summary of what you are about to do.",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Ordered list of steps you plan to take.",
      },
      reasoning: {
        type: "string",
        description: "Optional: brief explanation of why you chose this approach.",
      },
    },
    required: ["summary", "steps"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const summary = String(input["summary"] ?? "").trim();
    const steps = (input["steps"] as string[] | undefined) ?? [];
    const reasoning = input["reasoning"] as string | undefined;

    if (!summary || steps.length === 0) {
      return { content: "Error: summary and steps are required", isError: true };
    }

    // Build plan display
    const stepLines = steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
    let planText = `**Plan: ${summary}**\n\n${stepLines}`;

    if (reasoning) {
      planText += `\n\n*Reasoning: ${reasoning}*`;
    }

    // Show plan and ask for approval
    const channel = context.channel;
    if (channel && supportsInteractivity(channel)) {
      const response = await channel.requestConfirmation({
        chatId: context.chatId ?? "",
        userId: context.userId,
        question: planText,
        options: ["Approve", "Modify", "Reject"],
        details: `${steps.length} step${steps.length !== 1 ? "s" : ""} planned`,
      });

      if (response === "timeout") {
        return {
          content: "User did not respond within the timeout period. Do NOT proceed — wait for user input or ask again.",
          isError: true,
        };
      }

      if (response === "Approve") {
        return { content: "Plan approved by user. Proceed with execution." };
      }

      if (response === "Reject") {
        return { content: "Plan rejected by user. Ask what they would prefer instead." };
      }

      // "Modify" or any other response
      return {
        content: `User wants modifications: "${response}". Revise the plan based on their feedback and show it again.`,
      };
    }

    // Fallback: channel doesn't support interactivity
    return { content: "Unable to get plan approval interactively. Proceeding with the plan." };
  }
}
