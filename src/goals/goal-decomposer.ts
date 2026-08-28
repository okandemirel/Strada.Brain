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
import { streamOrChatText } from "../agents/providers/provider.interface.js";
import type {
  GoalNode,
  GoalTree,
  GoalNodeId,
  LLMDecompositionOutput,
} from "./types.js";
import { generateGoalNodeId, parseLLMOutput } from "./types.js";
import { validateDAG } from "./goal-validator.js";

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

/**
 * Runtime context passed to decomposition so the LLM can make
 * cost-aware, provider-aware decisions about granularity.
 */
export interface DecompositionContext {
  /** Number of healthy providers in the chain */
  readonly providerCount: number;
  /** Approximate context window of the primary provider (tokens) */
  readonly contextWindow?: number;
  /** Remaining daily budget in USD (0 = unlimited) */
  readonly remainingBudgetUsd?: number;
  /** Total node cap across all depths (default 12) */
  readonly maxTotalNodes?: number;
  /** Summary of primary provider's behavioral strengths for smart decomposition */
  readonly providerStrengths?: string;
  /**
   * Live framework API, read from Strada.Core / Modules / MCP themselves.
   *
   * A getter, not a string: the generator is wired asynchronously at boot and
   * does not exist yet when this context is set. Planning was the one place
   * this knowledge never reached — the orchestrator, the agent stage and the
   * delegation manager all received it, so every plan was written against
   * prose typed after an incident while execution worked from the source.
   */
  readonly frameworkKnowledge?: () => string | null;
  /** Live healthy-provider count, consulted at decomposition time (falls back
   *  to the static providerCount when absent). */
  readonly liveProviderCount?: () => number;
}

function buildProactivePrompt(ctx?: DecompositionContext): string {
  const frameworkSection = ctx?.frameworkKnowledge?.();
  const frameworkHint = frameworkSection
    ? `\n\nThe frameworks below were read from their own source at startup. Plan against what they actually provide, not against what a similar framework would:\n\n${frameworkSection}`
    : "";
  // LIVE count when the wiring provides one: the static bootstrap count told
  // the planner "2 providers — parallelize" while one sat in a multi-day
  // quota cooldown, shaping plans for parallelism the fleet could not deliver.
  const providerCount = ctx?.liveProviderCount?.() ?? ctx?.providerCount ?? 1;
  const maxNodes = ctx?.maxTotalNodes ?? 12;
  const budgetHint = ctx?.remainingBudgetUsd != null && ctx.remainingBudgetUsd > 0
    ? `\n- Remaining daily budget is ~$${ctx.remainingBudgetUsd.toFixed(2)} — prefer fewer, focused goals to conserve tokens`
    : "";
  const providerHint = providerCount <= 1
    ? "\n- IMPORTANT: Only 1 AI provider is available. Parallelism is impossible. Prefer a flat, sequential plan with fewer goals. Deep nesting wastes tokens on a single provider."
    : `\n- ${providerCount} providers are available — independent goals can run in parallel`;
  const behavioralHint = ctx?.providerStrengths
    ? `\n- Provider behavioral profile: ${ctx.providerStrengths}`
    : "";

  return `You are a goal decomposer for an AI development assistant.

Given a task, decide whether it needs decomposition and break it into sub-goals if appropriate.

Rules:
- If the task is simple and can be completed in a single execution pass, return exactly 1 sub-goal containing the full task
- For complex tasks, break into sub-goals forming a directed acyclic graph (DAG)
- Each sub-goal = one logical unit of work that produces a concrete, verifiable output
- Use dependsOn to express ordering constraints (not a flat list)
- Independent sub-goals should have empty dependsOn (they can run in parallel)
- Sequential sub-goals should depend on their prerequisite
- Set needsFurtherDecomposition=true ONLY for sub-goals that genuinely require multiple distinct implementation steps — most goals should be false
- The TOTAL number of goals across all depths must not exceed ${maxNodes}
- Cover every outcome the task names. If the task asks for a scene, a running build, a verified test pass, a published artifact — some sub-goal must PRODUCE that thing, and the plan is wrong without it
- Never substitute a document about a deliverable for the deliverable. "Write a plan describing the scene layout" does not satisfy "deliver a scene"
- A named deliverable may be scheduled late, but it may not be dropped: measured, three runs asked for a playable scene with prefabs and a verified play-mode run, and all three produced plans made only of "write the scripts"
- Prefer fewer, well-scoped goals over many granular ones

When the task is to build or extend a GAME — a GDD, a design document, "make this game", or a description of one someone imagined:
- The person asking may not be a developer or a prompt engineer. A design document plus "build this" is a COMPLETE instruction. Do not plan a goal whose output is a question for them, and do not plan a goal that writes a specification back at them: they already gave you one.
- The plan must reach a game someone can play, not a library that compiles. Somewhere in it: a scene, prefabs, a view layer that puts those prefabs on screen, and a play-mode run that passes with no test filter.
- Decide WHICH modules render before planning any of them. Most modules are mechanics: services and systems, pure logic, no MonoBehaviour anywhere in them — that is the normal shape and a module does not get one by default. A smaller number are presentation: views bound to the prefabs the design names. Make that split explicit in the plan and give the presentation work its own goals; do not sprinkle rendering through every module, and do not leave it to be discovered after the mechanics are done.
- Nothing renders by itself. Services and systems are deliberately NOT MonoBehaviours, so a plan made only of services and systems plans an empty screen. A goal must produce views: Strada.Core.Sync (EntityView on the prefab, EntityMediator and MediatorRegistry to bind state to it, ViewRegistry and ViewPool to spawn, ViewSyncRunner to drive) or Strada.Core.Patterns.View for plain views. Measured: a run delivered 85 scripts, 25 prefabs and 44 passing tests with zero MonoBehaviours and one GameObject in the scene.
- A prefab nothing references is invisible. Importing art and creating prefabs is half the work; the other half is the binding, and it is a planned goal, not a detail that surfaces later. If a config type holds prefab fields, the plan must create its .asset instance and assign the references, and the scene must contain whatever spawns or holds them. Measured: twenty-five prefabs, twenty-five sprites, a config class declaring three GameObject fields, zero .asset instances of it, and therefore nothing on screen.
- A scene holding only a bootstrapper is an empty screen. Say what the scene contains — camera, the objects the design names, whatever spawns the rest — and plan the work that puts them there. Measured: three GameObjects in the only scene of a project with a passing suite.
- Read the design for its shape and plan to that shape. If it names levels, level data, progression and the flow between them are their own goals, and so is whatever the design says happens between one level and the next. A game the design describes as level-based is not delivered by a single playable board.
- A green suite is not proof that anything was drawn. Tests exercise the simulation; only a captured frame shows the game. Plan a play-mode capture and read it: frames that are all identical, or a flat colour, mean nothing is rendering however many tests pass. Measured: forty-four of forty-four passing while all one hundred and twenty captured frames were the same empty sky.
- Build WITH Strada.Core, not merely started by it. Its Communication instead of hand-rolled C# events, its Logging (StradaLog) instead of Debug.Log, its Modules and DI or its ECS as the design fits — you need not use every subsystem, but never plan your own version of one the framework already provides. Measured on the same run: 6 of Strada.Core's 194 public types used, 22 hand-rolled events, 37 Debug.Log calls.
- Strada.MCP is how the project is built and checked: scene assembly, prefab work, compile verification and play-mode runs all have tools. A plan that ends at "write the code" has not verified anything.
- Every element the design schedules needs its own ART, planned as work: first unity_my_assets (local cache) or unity_my_assets_cloud (the account's full purchased library) for what the user already owns, then the generator that fits the element's layer — unity_generate_sprite for pixel-canvas pieces, unity_generate_mesh for dimensional ones, unity_prerender_frames to turn a 3D prefab into glossy 2D angle frames — and always the binding of that asset into the element's prefab. Measured 2026-08-26: a run delivered prefab structures and green tests while no scheduled element had any asset at all — the scenes were empty because no goal ever produced the art.${providerHint}${budgetHint}${behavioralHint}${frameworkHint}

Respond ONLY with JSON:
{"nodes": [{"id": "s1", "task": "description", "dependsOn": [], "needsFurtherDecomposition": false}, ...]}`;
}

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
// PROVIDER-OUTAGE ERROR
// =============================================================================

/**
 * Thrown by {@link GoalDecomposer.decomposeProactive} when the backing LLM call
 * fails because every provider is unavailable / unresponsive (all-providers-failed
 * or a first-response timeout) — a real outage, NOT a parse/validation hiccup.
 *
 * Callers surface this to the user (resilience pill + chat notice) and fail the
 * task cleanly instead of silently degrading to a single-node tree and leaving
 * the task hanging in PENDING.
 */
export class GoalDecompositionProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "GoalDecompositionProviderError";
  }
}

/**
 * Distinguish a genuine provider outage (all providers failed / unresponsive
 * endpoint / first-response timeout) from a transient parse/validation failure.
 * Only the former should surface + fail the task; the latter keeps the existing
 * silent single-node fallback. Matches the FallbackChain's terminal error
 * messages (fallback-chain.ts: "All providers failed", "sent no response within").
 */
export function isProviderOutageError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("all providers failed") ||
    msg.includes("providers failed or unavailable") ||
    msg.includes("sent no response within") ||
    msg.includes("unresponsive endpoint") ||
    // Rate-limiting (HTTP 429) that exhausted retries / backoff is a genuine provider
    // outage for surfacing purposes — fail the task cleanly with an honest cause
    // rather than silently degrading to a single-node tree.
    msg.includes("rate-limited") ||
    msg.includes("429") ||
    // A hard quota stop (provider's usage quota exhausted, no available provider) is
    // likewise a genuine outage for surfacing — fail cleanly with the honest cause.
    msg.includes("usage quota exhausted")
  );
}

// =============================================================================
// GOAL DECOMPOSER CLASS
// =============================================================================

export class GoalDecomposer {
  constructor(
    private readonly provider: IAIProvider | undefined,
    private readonly maxDepth: number = 3,
    /** Backoff between patient retry rounds on transient provider outages. Injectable for tests. */
    private readonly outageBackoffMs: readonly number[] = [0, 15_000, 30_000, 45_000],
  ) {}

  private decompositionContext: DecompositionContext | undefined;

  /** Inject runtime context so the LLM can make cost-aware decisions. */
  setDecompositionContext(ctx: DecompositionContext): void {
    this.decompositionContext = ctx;
  }

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

    // Skip LLM decomposition if provider is overloaded — use single-node fallback
    const providerName = this.provider.name;
    if (providerName) {
      const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
      const healthRegistry = ProviderHealthRegistry.getInstance();
      if (!healthRegistry.isAvailable(providerName)) {
        const { getLoggerSafe } = await import("../utils/logger.js");
        getLoggerSafe().info("Skipping goal decomposition — provider is in cooldown", { provider: providerName });
        return this.buildSingleNodeTree(sessionId, taskDescription);
      }
    }

    const rootId = generateGoalNodeId();
    const now = Date.now();

    const proactivePrompt = buildProactivePrompt(this.decompositionContext);
    const maxTotalNodes = this.decompositionContext?.maxTotalNodes ?? 12;

    // Attempt LLM decomposition with one retry
    let llmOutput = await this.callLLMForDecomposition(
      proactivePrompt,
      `Decompose this task into sub-goals:\n\n<task>${taskDescription}</task>`,
    );

    // If first attempt fails, retry with error feedback
    if (!llmOutput) {
      llmOutput = await this.callLLMForDecomposition(
        proactivePrompt,
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

    // Recursively decompose flagged nodes (depth-2) if within maxDepth and node cap
    if (this.maxDepth > 1) {
      const flaggedNodes = llmOutput.nodes.filter(
        (n) => n.needsFurtherDecomposition,
      );
      for (const flagged of flaggedNodes) {
        // Enforce total node cap — stop expanding if we're at/near the limit
        if (allNodes.size >= maxTotalNodes) break;

        // Find the GoalNode we created for this flagged LLM node
        const parentNode = depth1Nodes.find(
          (n) => n.task === flagged.task,
        );
        if (!parentNode) continue;
        if (parentNode.depth + 1 > this.maxDepth) continue;

        const remainingSlots = maxTotalNodes - allNodes.size;
        const subPrompt = buildProactivePrompt({
          ...this.decompositionContext,
          providerCount: this.decompositionContext?.providerCount ?? 1,
          maxTotalNodes: remainingSlots,
        });

        // A depth-2 outage must NOT discard the already-valid depth-1 tree — just
        // stop expanding and keep what we have (the top-level call is what guards
        // the reported "silent PENDING" bug). Only the FIRST (depth-1) call's outage
        // propagates to fail the task cleanly.
        let subOutput: LLMDecompositionOutput | null;
        try {
          subOutput = await this.callLLMForDecomposition(
            subPrompt,
            `Further decompose this sub-goal (max ${remainingSlots} sub-goals):\n\n<task>${flagged.task}</task>`,
          );
        } catch (err) {
          if (err instanceof GoalDecompositionProviderError) break;
          throw err;
        }

        if (subOutput) {
          const subNodes = this.buildNodesFromLLM(
            subOutput,
            parentNode.id,
            parentNode.depth,
          );
          for (const subNode of subNodes) {
            if (allNodes.size >= maxTotalNodes) break;
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
      // STREAM the decomposition call (mirrors the orchestrator's silentStream path).
      // Reasoning models (e.g. deepseek-v4-pro) can think silently for >90s; a blocking
      // provider.chat() never reports activity, so the FallbackChain's first-response
      // timer degenerates into a whole-call deadline and aborts with "sent no response
      // within Nms". chatStream fires markActivity on the first SSE chunk → the timer
      // clears → a slow reasoning stream is allowed to COMPLETE. The accumulating onChunk
      // collects chunk text; we parse the final response.text exactly as before (the
      // streamed text and the response.text are identical), so output is behavior-identical.
      //
      // PATIENCE (measured 2026-08-24, PixelFlow overnight): an upstream 503 storm
      // exhausted the chain's 3 fast retries in ~3 seconds, the decomposition threw,
      // and the whole mission idled for five hours. Provider-capacity blinks are
      // transient by nature — retry here on the SLOW clock before giving up.
      let response: Awaited<ReturnType<typeof streamOrChatText>> | undefined;
      const rounds = Math.max(1, this.outageBackoffMs.length);
      for (let round = 0; round < rounds; round++) {
        if ((this.outageBackoffMs[round] ?? 0) > 0) {
          await new Promise((r) => setTimeout(r, this.outageBackoffMs[round]));
        }
        try {
          response = await streamOrChatText(this.provider, systemPrompt, userMessage);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const transient = /providers failed|503|500|502|504|network|timeout|ECONN/i.test(msg);
          const { getLoggerSafe } = await import("../utils/logger.js");
          getLoggerSafe().warn(
            `Goal decomposition attempt ${round + 1}/${rounds} failed` +
              (transient && round < rounds - 1 ? "; retrying on the slow clock" : ""),
            { error: msg.slice(0, 200) },
          );
          if (!transient || round === rounds - 1) throw err;
        }
      }
      if (!response) {
        return null;
      }

      const parsed = parseLLMOutput(response.text);
      if (!parsed) {
        const { getLoggerSafe } = await import("../utils/logger.js");
        getLoggerSafe().warn("Goal decomposition LLM output parse failed", {
          responsePreview: response.text.slice(0, 300),
          provider: this.provider.name,
        });
        return null;
      }

      const validation = validateDAG(parsed.nodes);
      if (!validation.valid) {
        const { getLoggerSafe } = await import("../utils/logger.js");
        getLoggerSafe().warn("Goal decomposition DAG validation failed", {
          cycleNodes: validation.cycleNodes,
          danglingRefs: validation.danglingRefs,
          nodeCount: parsed.nodes.length,
        });
        return null;
      }

      return parsed;
    } catch (err) {
      const { getLoggerSafe } = await import("../utils/logger.js");
      getLoggerSafe().warn("Goal decomposition LLM call failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // A genuine provider outage (all providers failed / unresponsive endpoint)
      // must NOT be swallowed into a silent single-node fallback — propagate it as a
      // typed error so the caller surfaces a user notice + fails the task cleanly.
      // Transient parse/validation hiccups still fall back to null (degrade silently).
      if (isProviderOutageError(err)) {
        throw new GoalDecompositionProviderError(
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
      }
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
