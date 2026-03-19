/**
 * Show Plan Tool -- Surfaces an execution-ready plan for Strada's internal review.
 *
 * Used when the agent wants to make its current plan explicit.
 * Strada treats plans as internal by default and does not wait for user approval.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

export class ShowPlanTool implements ITool {
  readonly name = "show_plan";
  readonly description =
    "Expose your current execution-ready plan so Strada can review it internally. " +
    "Do not use this to wait for user approval unless the user explicitly asked to review a plan first. " +
    "Use it when the plan itself needs to be made explicit inside the orchestration loop.";

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
    _context: ToolContext,
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

    return {
      content:
        `${planText}\n\n` +
        `Plan surfaced for Strada's internal review (${steps.length} step${steps.length !== 1 ? "s" : ""}). ` +
        "Proceed without waiting for user approval unless a real external blocker remains.",
    };
  }
}
