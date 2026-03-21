/**
 * Delegation Tool
 *
 * ITool implementation that wraps a delegation type, allowing LLMs to delegate
 * subtasks to sub-agents. Each DelegationTypeConfig produces one DelegationTool
 * with name "delegate_{typeName}".
 *
 * Factory function createDelegationTools() enforces depth limits by returning
 * an empty array at max depth (preventing recursive delegation).
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

import type { ITool, ToolMetadata } from "../../tools/tool.interface.js";
import type { ToolContext, ToolExecutionResult, ToolInputSchema } from "../../tools/tool-core.interface.js";
import type { DelegationTypeConfig, DelegationRequest } from "./delegation-types.js";
import type { DelegationManager } from "./delegation-manager.js";
import type { AgentId } from "../agent-types.js";

// =============================================================================
// DELEGATION TOOL
// =============================================================================

export class DelegationTool implements ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly metadata: ToolMetadata;

  constructor(
    private readonly typeConfig: DelegationTypeConfig,
    private readonly delegationManager: DelegationManager,
    private readonly parentAgentId: AgentId,
    private readonly currentDepth: number,
  ) {
    this.name = `delegate_${typeConfig.name}`;

    this.description =
      typeConfig.systemPrompt ??
      `Delegate a ${typeConfig.name.replace(/_/g, " ")} subtask to a specialized sub-agent. The sub-agent will execute the task and return the result.`;

    this.inputSchema = {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task to delegate",
        },
        context: {
          type: "string",
          description: "Additional context for the sub-agent",
        },
        mode: {
          type: "string",
          enum: ["sync", "async"],
          description: "sync waits for result, async returns immediately",
        },
      },
      required: ["task"],
    };

    this.metadata = {
      name: this.name,
      description: this.description,
      category: "delegation" as never,
      riskLevel: "medium" as never,
      isReadOnly: false,
      requiresConfirmation: false,
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const mode = (input.mode as string | undefined) === "async" ? "async" : "sync";

      const request: DelegationRequest = {
        type: this.typeConfig.name,
        task: input.task as string,
        context: input.context as string | undefined,
        parentAgentId: this.parentAgentId,
        depth: this.currentDepth,
        mode,
        toolContext: context,
      };

      if (mode === "async") {
        void this.delegationManager.delegateAsync(request);
        return {
          content: `[Delegating ${this.typeConfig.name} to sub-agent...]`,
          metadata: { delegationMode: "async" },
        };
      }

      const result = await this.delegationManager.delegate(request);
      return {
        content: result.content,
        metadata: {
          ...result.metadata,
          workerResult: result.workerResult,
          delegationType: this.typeConfig.name,
          delegationMode: "sync",
        },
      };
    } catch (error) {
      return {
        content: `[Sub-agent failed: ${error instanceof Error ? error.message : String(error)}]`,
        isError: true,
      };
    }
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create delegation tools from config types with depth enforcement.
 *
 * Returns empty array at max depth (depth enforcement via tool exclusion per
 * RESEARCH Pattern 2 -- sub-agents at max depth simply don't see delegation tools).
 */
export function createDelegationTools(
  types: DelegationTypeConfig[],
  delegationManager: DelegationManager,
  parentAgentId: AgentId,
  currentDepth: number,
  maxDepth: number,
): DelegationTool[] {
  if (currentDepth >= maxDepth) {
    return [];
  }

  return types.map(
    (type) =>
      new DelegationTool(type, delegationManager, parentAgentId, currentDepth + 1),
  );
}
