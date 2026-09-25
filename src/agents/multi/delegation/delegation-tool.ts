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
// PARENT IDENTITY
// =============================================================================

/**
 * Who a delegation is booked and limited under: a fixed agent id, or an id resolved per call
 * from the calling tool context.
 */
export type DelegationParent = AgentId | ((context: ToolContext) => AgentId);

export function resolveDelegationParent(parent: DelegationParent, context: ToolContext): AgentId {
  return typeof parent === "function" ? parent(context) : parent;
}

/** Prefix of the parent ids the root orchestrator's delegations carry, one per chat. */
const ROOT_DELEGATION_PARENT_PREFIX = "root-chat:";

/**
 * The root orchestrator serves every chat, and its delegations used one random id minted per
 * boot: no registered agent matched it, so no per-parent budget cap or reservation applied, and
 * every chat shared one concurrency pool. Its delegations now belong to the chat that asked for
 * them, under an id that is stable across restarts.
 */
export function rootDelegationParentId(context: ToolContext): AgentId {
  return `${ROOT_DELEGATION_PARENT_PREFIX}${context.chatId ?? "default"}` as AgentId;
}

export function isRootDelegationParentId(agentId: string): boolean {
  return agentId.startsWith(ROOT_DELEGATION_PARENT_PREFIX);
}

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
    private readonly parentAgentId: DelegationParent,
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
        // No "async" mode: nothing ever handed a detached sub-agent's result back to the
        // parent, and the child kept spending and committing files after the parent's run.
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
      // Always synchronous, even when a model still asks for mode:"async": the result is the
      // point of delegating, and a sub-agent must not outlive the run that asked for it.
      const request: DelegationRequest = {
        type: this.typeConfig.name,
        task: input.task as string,
        context: input.context as string | undefined,
        parentAgentId: resolveDelegationParent(this.parentAgentId, context),
        depth: this.currentDepth,
        mode: "sync",
        toolContext: context,
      };

      const result = await this.delegationManager.delegate(request);
      // A blocked sub-agent stopped short of the task; the parent must not read it as done.
      const blocked = result.workerResult?.status === "blocked";
      return {
        content: blocked ? `BLOCKED: ${result.content}` : result.content,
        ...(blocked ? { isError: true } : {}),
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
  parentAgentId: DelegationParent,
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
