/**
 * Goal Decomposer
 *
 * Replaces TaskDecomposer with DAG-based goal decomposition.
 * Supports both proactive (upfront tree generation) and reactive
 * (re-decomposition of failing nodes) decomposition strategies.
 *
 * Uses heuristic pre-check to avoid LLM calls for simple tasks,
 * then produces validated DAG structures via LLM with cycle detection.
 */

import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type {
  GoalNode,
  GoalTree,
  GoalNodeId,
  LLMDecompositionOutput,
} from "./types.js";
import { generateGoalNodeId, parseLLMOutput } from "./types.js";
import { validateDAG } from "./goal-validator.js";
import { getLoggerSafe } from "../utils/logger.js";

// =============================================================================
// DECOMPOSITION GUARD — minimal, language-agnostic
// =============================================================================
// The LLM is the only component that understands all languages.
// shouldDecompose is a MINIMAL pre-filter: it only blocks obviously
// trivial messages to avoid a wasted LLM call. Everything else goes
// to the LLM which returns a single-node tree if the task is simple.

// =============================================================================
// LLM PROMPTS
// =============================================================================

const PROACTIVE_PROMPT = `You are a goal decomposer for an AI development assistant.

Given a task, decide whether it needs decomposition and break it into sub-goals if appropriate.

Rules:
- If the task is simple and can be completed in a single execution pass, return exactly 1 sub-goal containing the full task
- For complex tasks, break into 2-8 sub-goals forming a directed acyclic graph (DAG)
- Each sub-goal = one logical unit of work
- Use dependsOn to express ordering constraints (not a flat list)
- Independent sub-goals should have empty dependsOn (they can run in parallel)
- Sequential sub-goals should depend on their prerequisite
- Set needsFurtherDecomposition=true for sub-goals that are themselves complex

Respond ONLY with JSON:
{"nodes": [{"id": "s1", "task": "description", "dependsOn": [], "needsFurtherDecomposition": false}, ...]}`;

const REACTIVE_PROMPT = `You are a goal decomposer for an AI development assistant.

A sub-goal has FAILED during execution. Decompose it into smaller, more specific sub-goals
that address the failure. Use the failure context to guide the decomposition.

Rules:
- Break the failing goal into 1-4 smaller recovery steps
- Use dependsOn for ordering
- Focus on addressing the root cause of the failure
- Include verification/retry steps

Respond ONLY with JSON:
{"nodes": [{"id": "r1", "task": "description", "dependsOn": []}, ...]}`;

// =============================================================================
// GOAL DECOMPOSER CLASS
// =============================================================================

export class GoalDecomposer {
  constructor(
    private readonly provider: IAIProvider | undefined,
    private readonly maxDepth: number = 3,
  ) {}

  /**
   * Heuristic check: should this prompt be decomposed into sub-goals?
   * Returns true for complex multi-step requests, false for simple ones.
   */
  shouldDecompose(prompt: string): boolean {
    const trimmed = prompt.trim();
    // Skip decomposition for short messages (greetings, simple questions,
    // single-sentence requests). Aligned with TaskClassifier's "moderate"
    // complexity boundary at 60 chars to avoid triggering supervisor
    // evaluation and workspace lease acquisition for conversational input.
    return trimmed.length >= 60;
  }

  /**
   * Proactively decompose a task into a goal tree before execution.
   * Uses LLM to generate DAG structure with optional recursive depth.
   */
  async decomposeProactive(
    sessionId: string,
    taskDescription: string,
  ): Promise<GoalTree> {
    // No provider -- return single-node tree
    if (!this.provider) {
      return this.buildSingleNodeTree(sessionId, taskDescription);
    }

    const rootId = generateGoalNodeId();
    const now = Date.now();

    // Attempt LLM decomposition with one retry
    let llmOutput = await this.callLLMForDecomposition(
      PROACTIVE_PROMPT,
      `Decompose this task into sub-goals:\n\n<task>${taskDescription}</task>`,
    );

    // If first attempt fails, retry with error feedback
    if (!llmOutput) {
      llmOutput = await this.callLLMForDecomposition(
        PROACTIVE_PROMPT,
        `Previous attempt failed to produce valid JSON. Please try again.\n\nDecompose this task into sub-goals:\n\n<task>${taskDescription}</task>`,
      );
    }

    // If both attempts fail, fall back to single-node tree
    if (!llmOutput) {
      return this.buildSingleNodeTree(sessionId, taskDescription);
    }

    // Build depth-1 nodes from LLM output
    const depth1Nodes = this.buildNodesFromLLM(llmOutput, rootId, 0);

    // Collect all nodes (root + depth-1)
    const allNodes = new Map<GoalNodeId, GoalNode>();
    allNodes.set(rootId, {
      id: rootId,
      parentId: null,
      task: taskDescription,
      dependsOn: [],
      depth: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    for (const node of depth1Nodes) {
      allNodes.set(node.id, node);
    }

    // Recursively decompose flagged nodes (depth-2) if within maxDepth
    if (this.maxDepth > 1) {
      const flaggedNodes = llmOutput.nodes.filter(
        (n) => n.needsFurtherDecomposition,
      );
      for (const flagged of flaggedNodes) {
        // Find the GoalNode we created for this flagged LLM node
        const parentNode = depth1Nodes.find(
          (n) => n.task === flagged.task,
        );
        if (!parentNode) continue;
        if (parentNode.depth + 1 > this.maxDepth) continue;

        const subOutput = await this.callLLMForDecomposition(
          PROACTIVE_PROMPT,
          `Further decompose this sub-goal:\n\n<task>${flagged.task}</task>`,
        );

        if (subOutput) {
          const subNodes = this.buildNodesFromLLM(
            subOutput,
            parentNode.id,
            parentNode.depth,
          );
          for (const subNode of subNodes) {
            allNodes.set(subNode.id, subNode);
          }
        }
      }
    }

    const tree: GoalTree = {
      rootId,
      sessionId,
      taskDescription,
      nodes: allNodes,
      createdAt: now,
    };

    return tree;
  }

  /**
   * Reactively decompose a failing node into sub-goals.
   * Returns null if the failing node is at maxDepth (cannot decompose further).
   */
  async decomposeReactive(
    tree: GoalTree,
    failingNodeId: GoalNodeId,
    reflectionContext: string,
  ): Promise<GoalTree | null> {
    const failingNode = tree.nodes.get(failingNodeId);
    if (!failingNode) return null;

    // Depth guard: cannot decompose beyond maxDepth
    if (failingNode.depth >= this.maxDepth) return null;

    if (!this.provider) return null;

    // Build context about what has succeeded so far
    const completedNodes = Array.from(tree.nodes.values())
      .filter((n) => n.status === "completed")
      .map((n) => `  - [completed] ${n.task}`)
      .join("\n");

    const userMessage = `The following sub-goal FAILED:\n<failed_task>${failingNode.task}</failed_task>\n<failure_context>${reflectionContext}</failure_context>\n\nCompleted so far:\n${completedNodes || "  (none)"}\n\nDecompose the failing sub-goal into smaller recovery steps.`;

    const llmOutput = await this.callLLMForDecomposition(
      REACTIVE_PROMPT,
      userMessage,
    );

    if (!llmOutput) return null;

    // Build new child nodes for the failing node
    const newNodes = this.buildNodesFromLLM(
      llmOutput,
      failingNodeId,
      failingNode.depth,
    );

    // Merge into existing tree
    const updatedNodes = new Map(tree.nodes);
    for (const node of newNodes) {
      updatedNodes.set(node.id, node);
    }

    return {
      ...tree,
      nodes: updatedNodes,
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /** Call LLM and parse/validate the output */
  private async callLLMForDecomposition(
    systemPrompt: string,
    userMessage: string,
  ): Promise<LLMDecompositionOutput | null> {
    if (!this.provider) return null;

    try {
      const response = await this.provider.chat(
        systemPrompt,
        [{ role: "user", content: userMessage }],
        [],
      );

      const parsed = parseLLMOutput(response.text);
      if (!parsed) return null;

      const validation = validateDAG(parsed.nodes);
      if (!validation.valid) {
        getLoggerSafe().warn("Goal decomposition DAG validation failed", {
          cycleNodes: validation.cycleNodes,
          danglingRefs: validation.danglingRefs,
          nodeCount: parsed.nodes.length,
        });
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  /** Build a single-node tree (fallback when decomposition fails or is unnecessary) */
  private buildSingleNodeTree(
    sessionId: string,
    taskDescription: string,
  ): GoalTree {
    const rootId = generateGoalNodeId();
    const childId = generateGoalNodeId();
    const now = Date.now();

    const nodes = new Map<GoalNodeId, GoalNode>();
    nodes.set(rootId, {
      id: rootId,
      parentId: null,
      task: taskDescription,
      dependsOn: [],
      depth: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    nodes.set(childId, {
      id: childId,
      parentId: rootId,
      task: taskDescription,
      dependsOn: [],
      depth: 1,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return {
      rootId,
      sessionId,
      taskDescription,
      planSummary: "Fallback single-step execution",
      nodes,
      createdAt: now,
    };
  }

  /**
   * Convert LLM output nodes to GoalNode array with generated IDs.
   * Maps LLM string IDs to GoalNodeIds and remaps dependsOn references.
   */
  private buildNodesFromLLM(
    output: LLMDecompositionOutput,
    parentId: GoalNodeId,
    parentDepth: number,
  ): GoalNode[] {
    const now = Date.now();
    const childDepth = parentDepth + 1;

    // Create ID mapping: LLM string id -> GoalNodeId
    const idMap = new Map<string, GoalNodeId>();
    for (const llmNode of output.nodes) {
      idMap.set(llmNode.id, generateGoalNodeId());
    }

    // Build GoalNodes with remapped IDs
    const nodes: GoalNode[] = [];
    for (const llmNode of output.nodes) {
      const nodeId = idMap.get(llmNode.id)!;
      const dependsOn = llmNode.dependsOn
        .map((dep) => idMap.get(dep))
        .filter((id): id is GoalNodeId => id !== undefined);

      nodes.push({
        id: nodeId,
        parentId,
        task: llmNode.task,
        dependsOn,
        depth: childDepth,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }

    return nodes;
  }
}
