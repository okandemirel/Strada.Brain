/**
 * Swarm tool — fan out independent subtasks across every available account.
 *
 * The per-type `delegate_*` tools spawn ONE sub-agent at a time, so an agent
 * holding five independent chunks of work runs them serially even when the
 * deployment has several provider accounts idle. This tool takes the list and
 * runs it concurrently, bounded by the delegation manager's own
 * capacity-derived concurrency (see config: maxConcurrentPerParent scales with
 * the number of configured accounts), then returns one consolidated report.
 *
 * Failures are reported per task rather than aborting the batch: a swarm whose
 * third member fails still returns the other four results, which is the whole
 * reason to fan out.
 */

import type { ITool, ToolContext, ToolExecutionResult, ToolInputSchema, ToolMetadata } from "../../tools/tool.interface.js";
import type { AgentId } from "../agent-types.js";
import type { DelegationManager } from "./delegation-manager.js";
import type { DelegationResult, DelegationTypeConfig } from "./delegation-types.js";

interface SwarmTaskSpec {
  task: string;
  type?: string;
  context?: string;
}

export class SwarmTool implements ITool {
  readonly name = "swarm_tasks";
  readonly description =
    "Run several INDEPENDENT subtasks in parallel across the available sub-agent capacity, " +
    "then return every result together. Use it whenever the next step is a list of chunks that " +
    "do not depend on each other (e.g. implement five unrelated elements, or audit six modules). " +
    "Dependent work must stay sequential — order matters there, and this tool does not guarantee it.";

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "Independent subtasks to run concurrently (2-12).",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "What this sub-agent must do" },
            type: { type: "string", description: "Delegation type (defaults to the first configured type)" },
            context: { type: "string", description: "Extra context for this subtask" },
          },
          required: ["task"],
        },
      },
    },
    required: ["tasks"],
  };

  readonly metadata: ToolMetadata = {
    name: "swarm_tasks",
    description: "Run independent subtasks in parallel across available sub-agent capacity",
    category: "delegation" as never,
    riskLevel: "medium" as never,
    isReadOnly: false,
    requiresConfirmation: false,
  };

  constructor(
    private readonly types: DelegationTypeConfig[],
    private readonly delegationManager: DelegationManager,
    private readonly parentAgentId: AgentId,
    private readonly depth: number,
    /** Pool width — the manager's own per-parent concurrency limit. */
    private readonly maxConcurrent: number = 3,
  ) {}

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const rawTasks = Array.isArray(input["tasks"]) ? (input["tasks"] as SwarmTaskSpec[]) : [];
    const accepted = rawTasks.filter((t) => t && typeof t.task === "string" && t.task.trim().length > 0);
    const tasks = accepted.slice(0, 12);
    const dropped = accepted.length - tasks.length;
    // `dropped` was the ONLY drop counter and it was computed from the already
    // filtered array, so an entry with no usable `task` string vanished: six
    // submitted tasks reported "Swarm of 5 sub-agents finished." and the caller
    // marked the batch done with one module unaudited (audited 2026-09-02).
    const malformed = rawTasks.length - accepted.length;

    if (tasks.length < 2) {
      return {
        content:
          "swarm_tasks needs at least 2 independent tasks — for a single task use the delegate_* tool directly.",
        isError: true,
      };
    }

    const defaultType = this.types[0]?.name ?? "general";

    // BOUNDED POOL, not a burst. delegate() rejects (it does not queue) past
    // the parent's concurrency limit, so firing every task in one tick
    // returned "N of M subtasks failed — max concurrent delegations
    // exceeded": the overflow was DROPPED, not deferred (audited
    // 2026-09-01). Run a worker pool at the manager's own width instead.
    const width = Math.max(1, this.maxConcurrent);
    const results: Array<PromiseSettledResult<unknown>> = new Array(tasks.length);
    let next = 0;
    const runner = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const spec = tasks[index];
        if (!spec) return;
        try {
          const value = await this.delegationManager.delegate({
            parentAgentId: this.parentAgentId,
            type: this.types.find((t) => t.name === spec.type)?.name ?? defaultType,
            task: spec.context ? `${spec.task}\n\nContext: ${spec.context}` : spec.task,
            depth: this.depth,
            mode: "sync",
            // The sub-agent inherits the caller's authorized paths; without
            // it a swarm member is refused files the user explicitly named.
            toolContext: context,
          } as never);
          results[index] = { status: "fulfilled", value };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, () => runner()));
    const settled = results;

    const lines: string[] = [`Swarm of ${tasks.length} sub-agents finished.`];
    if (dropped > 0) {
      // Silently discarding tasks 13+ let a caller believe work was done.
      lines.push(`NOTE: ${dropped} task(s) beyond the limit of 12 were NOT run — resubmit them in another swarm.`);
    }
    if (malformed > 0) {
      lines.push(
        `NOTE: ${malformed} of ${rawTasks.length} submitted entries were NOT run — they had no usable \`task\` string. ` +
          "Resubmit them with a non-empty `task`.",
      );
    }
    let failures = 0;
    settled.forEach((outcome, i) => {
      const label = tasks[i]!.task.slice(0, 80);
      if (outcome.status === "fulfilled") {
        // delegate() resolves with a DelegationResult — { content, workerResult,
        // metadata } — never { success, output }. Reading the invented shape
        // rendered every successful subtask as "(no output)" under a success
        // banner, so the parent reported the batch complete with zero evidence
        // of the work (audited 2026-09-02). A failed worker REJECTS (the manager
        // rethrows it), so a fulfilled value is finished unless the worker
        // itself says it stopped short.
        const result = outcome.value as DelegationResult | undefined;
        const status = result?.workerResult?.status;
        const notFinished = status !== undefined && status !== "completed";
        if (notFinished) failures++;
        const prefix = status === "failed" ? "FAILED: " : status === "blocked" ? "BLOCKED: " : "";
        const text =
          result?.content?.trim()
          || result?.workerResult?.finalSummary?.trim()
          || "(no output)";
        lines.push(`\n### ${i + 1}. ${label}\n${prefix}${text.slice(0, 1500)}`);
      } else {
        failures++;
        lines.push(`\n### ${i + 1}. ${label}\nFAILED: ${String(outcome.reason).slice(0, 300)}`);
      }
    });
    if (failures > 0) {
      lines.push(`\n${failures} of ${tasks.length} subtasks failed — handle them before reporting completion.`);
    }

    return { content: lines.join("\n"), isError: failures === tasks.length };
  }
}

/** Swarm is offered only where delegation itself is (same depth rule). */
export function createSwarmTool(
  types: DelegationTypeConfig[],
  delegationManager: DelegationManager,
  parentAgentId: AgentId,
  currentDepth: number,
  maxDepth: number,
  maxConcurrent = 3,
): SwarmTool[] {
  if (currentDepth >= maxDepth || types.length === 0) return [];
  return [new SwarmTool(types, delegationManager, parentAgentId, currentDepth + 1, maxConcurrent)];
}
