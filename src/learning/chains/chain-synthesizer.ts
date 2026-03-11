/**
 * ChainSynthesizer -- LLM-based chain metadata generation and CompositeTool factory
 *
 * Takes candidate chains from ChainDetector, uses LLM to generate names,
 * descriptions, and parameter mappings, then creates instincts and registers
 * composite tools.
 *
 * V2: Additionally generates compensation actions, reversibility flags, and
 * DAG step dependencies in a single LLM call. Falls back to V1 when LLM
 * does not generate V2 fields.
 *
 * Respects budget caps (llmBudgetPerCycle, maxActive) and validates tool
 * existence before registration (TOOL-05).
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { IEventEmitter, LearningEventMap } from "../../core/event-bus.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type {
  CandidateChain,
  ToolChainConfig,
  ChainMetadata,
  ChainMetadataV2,
  LLMChainOutput,
  LLMChainOutputV2,
  ChainStepNode,
} from "./chain-types.js";
import {
  LLMChainOutputSchema,
  LLMChainOutputV2Schema,
  computeSuccessRate,
  computeCompositeMetadata,
  parseLLMJsonOutput,
  safeStringify,
} from "./chain-types.js";
import { validateChainDAG } from "./chain-dag.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";
import { CompositeTool } from "./composite-tool.js";
import { createInstinctId, CONFIDENCE_THRESHOLDS } from "../types.js";
import type { Instinct, TrajectoryId } from "../types.js";
import type { NormalizedScore, TimestampMs } from "../../types/index.js";
import { getLogger } from "../../utils/logger.js";

// =============================================================================
// LLM PROMPT
// =============================================================================

const SYNTHESIS_SYSTEM_PROMPT = `You are a tool chain synthesizer for an AI development assistant.

Given a recurring sequence of tool calls, generate a composite tool definition:
- name: snake_case, 3-50 chars, starts with lowercase letter (e.g., "read_and_write_file")
- description: human-readable, 10-300 chars
- parameterMappings: describe how data flows between steps
  - Each mapping has: stepIndex (0-based), parameterName, source (userInput/previousOutput/constant), sourceKey (optional), defaultValue (optional)
- inputSchema: JSON schema for the composite tool's input (optional)
- steps: array of step nodes for each tool in the sequence
  - Each step has: stepId ("step_0", "step_1", ...), toolName, dependsOn (array of stepIds this step depends on -- use [] for first step or parallel-capable steps), reversible (boolean), compensatingAction (optional: { toolName: string (must be from available tools list), inputMappings: { paramName: "step_N.fieldName" } })
- isFullyReversible: true only if ALL steps have reversible=true

Available tools for compensation are listed in the user message below.
Tools marked readOnly are always reversible. Tools marked dangerous should be irreversible unless you can identify a specific compensation tool.

Respond ONLY with JSON:
{"name": "...", "description": "...", "parameterMappings": [...], "inputSchema": {...}, "steps": [...], "isFullyReversible": true/false}`;

export class ChainSynthesizer {
  private provider: IAIProvider | undefined;

  constructor(
    private readonly learningStorage: LearningStorage,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventBus: IEventEmitter<LearningEventMap>,
    private readonly config: ToolChainConfig,
  ) {}

  /** Set the AI provider for LLM calls */
  setProvider(provider: IAIProvider): void {
    this.provider = provider;
  }

  /**
   * Synthesize composite tools from candidate chains.
   *
   * For each candidate (up to budget limits):
   * 1. Validate all tools exist
   * 2. Call LLM to generate metadata (V2 with DAG + compensation, or V1 fallback)
   * 3. Create instinct, register CompositeTool, emit event
   */
  async synthesize(candidates: CandidateChain[]): Promise<CompositeTool[]> {
    if (!this.provider) return [];

    // Count active chains to enforce maxActive cap
    const activeChains = this.learningStorage.getInstincts({
      type: "tool_chain",
      status: "active",
    });
    const activeCount = activeChains.length;

    // Budget: min of llmBudgetPerCycle, remaining capacity, and candidate count
    const remainingCapacity = Math.max(0, this.config.maxActive - activeCount);
    const budget = Math.min(
      this.config.llmBudgetPerCycle,
      remainingCapacity,
      candidates.length,
    );

    const created: CompositeTool[] = [];

    for (let i = 0; i < candidates.length && created.length < budget; i++) {
      const candidate = candidates[i]!;

      // TOOL-05: Validate all tools in sequence exist before proceeding
      const allToolsExist = candidate.toolNames.every((name) =>
        this.toolRegistry.has(name),
      );
      if (!allToolsExist) continue;

      try {
        // Call LLM to generate metadata
        const llmResult = await this.callLLM(candidate);
        if (!llmResult) continue;

        // Prevent LLM-generated names from shadowing existing non-composite tools
        const existingMeta = this.toolRegistry.getMetadata(llmResult.output.name);
        if (existingMeta && existingMeta.category !== "composite") continue;

        // Build chain metadata from LLM output + candidate data
        const successRate = computeSuccessRate(candidate);

        if (llmResult.isV2) {
          // V2 path: DAG + compensation + reversibility
          const tool = this.buildV2Chain(
            llmResult.output as LLMChainOutputV2,
            candidate,
            successRate,
          );
          if (tool) created.push(tool);
        } else {
          // V1 path: backward compat
          const tool = this.buildV1Chain(llmResult.output, candidate, successRate);
          if (tool) created.push(tool);
        }
      } catch {
        // LLM failure for one candidate should not prevent others
        continue;
      }
    }

    return created;
  }

  /**
   * Build a V2 chain with DAG validation, compensation validation, and safety net.
   */
  private buildV2Chain(
    llmOutput: LLMChainOutputV2,
    candidate: CandidateChain,
    successRate: number,
  ): CompositeTool | null {
    // Validate DAG, fall back to sequential on cycle
    let steps = this.validateAndFixDAG(llmOutput.steps, candidate.toolNames);

    // Validate compensation tools and apply safety net
    steps = this.validateCompensationTools(steps);

    // Compute actual isFullyReversible from validated steps
    const isFullyReversible = this.computeIsFullyReversible(steps);

    const chainMetadata: ChainMetadataV2 = {
      version: 2,
      toolSequence: candidate.toolNames,
      steps,
      parameterMappings: llmOutput.parameterMappings,
      isFullyReversible,
      successRate,
      occurrences: candidate.occurrences,
    };

    // Append [rollback-capable] if fully reversible
    const description = isFullyReversible
      ? `${llmOutput.description} [rollback-capable]`
      : llmOutput.description;

    return this.createAndRegisterChain(
      llmOutput.name,
      description,
      llmOutput.inputSchema ?? {},
      chainMetadata,
      candidate,
      successRate,
    );
  }

  /**
   * Build a V1 chain (backward compatible path).
   */
  private buildV1Chain(
    llmOutput: LLMChainOutput,
    candidate: CandidateChain,
    successRate: number,
  ): CompositeTool | null {
    const chainMetadata: ChainMetadata = {
      toolSequence: candidate.toolNames,
      parameterMappings: llmOutput.parameterMappings,
      successRate,
      occurrences: candidate.occurrences,
    };

    return this.createAndRegisterChain(
      llmOutput.name,
      llmOutput.description,
      llmOutput.inputSchema ?? {},
      chainMetadata,
      candidate,
      successRate,
    );
  }

  /**
   * Create instinct, register CompositeTool, emit event.
   * Shared between V1 and V2 paths.
   */
  private createAndRegisterChain(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    chainMetadata: ChainMetadata | ChainMetadataV2,
    candidate: CandidateChain,
    successRate: number,
  ): CompositeTool {
    // Create instinct with confidence capped at MAX_INITIAL
    const instinctId = createInstinctId();
    const confidence = Math.min(
      successRate,
      CONFIDENCE_THRESHOLDS.MAX_INITIAL,
    );

    const now = Date.now();
    const instinct: Instinct = {
      id: instinctId,
      name,
      type: "tool_chain",
      status: "proposed",
      confidence: confidence as NormalizedScore,
      triggerPattern: candidate.key,
      action: JSON.stringify(chainMetadata),
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 0,
        timesFailed: 0,
        successRate: 0 as NormalizedScore,
        averageExecutionMs: 0,
      },
      createdAt: now as TimestampMs,
      updatedAt: now as TimestampMs,
      sourceTrajectoryIds: [] as TrajectoryId[],
      tags: ["chain", "composite"],
    };

    this.learningStorage.createInstinct(instinct);

    // Create CompositeTool (uses V1 chainMetadata fields for execution;
    // V2 data stored in instinct.action for Plan 03 to access)
    const v1Compat: ChainMetadata = {
      toolSequence: "toolSequence" in chainMetadata ? chainMetadata.toolSequence : [],
      parameterMappings: chainMetadata.parameterMappings,
      successRate: chainMetadata.successRate,
      occurrences: chainMetadata.occurrences,
    };

    const tool = new CompositeTool(
      {
        name,
        description,
        inputSchema,
        chainMetadata: v1Compat,
      },
      this.toolRegistry,
      this.eventBus,
    );

    // Register with metadata inheriting confirmation gates from component tools
    const toolMeta = computeCompositeMetadata(
      candidate.toolNames.map((n) => this.toolRegistry.getMetadata(n)),
    );
    this.toolRegistry.registerOrUpdate(tool, toolMeta);

    // Emit chain:detected event
    this.eventBus.emit("chain:detected", {
      chainName: name,
      toolSequence: candidate.toolNames,
      occurrences: candidate.occurrences,
      successRate,
      instinctId: instinctId as string,
      timestamp: now,
    });

    return tool;
  }

  /**
   * Validate DAG acyclicity and fix if needed.
   * If DAG is invalid (cycle), falls back to sequential dependsOn.
   */
  private validateAndFixDAG(
    steps: ChainStepNode[],
    toolNames: string[],
  ): ChainStepNode[] {
    const dagResult = validateChainDAG(steps);
    if (dagResult.valid) {
      return steps;
    }

    // Fall back to sequential (linear dependsOn)
    getLogger().info("V2 synthesis: cyclic DAG detected, falling back to sequential", {
      cycleNodes: dagResult.cycleNodes,
    });

    return toolNames.map((toolName, i) => {
      // Preserve existing step properties (reversible, compensation) from the original steps
      const originalStep = steps.find((s) => s.toolName === toolName);
      return {
        stepId: `step_${i}`,
        toolName,
        dependsOn: i > 0 ? [`step_${i - 1}`] : [],
        reversible: originalStep?.reversible ?? false,
        compensatingAction: originalStep?.compensatingAction,
      };
    });
  }

  /**
   * Validate compensation tools against ToolRegistry and apply safety net.
   *
   * - Invalid compensation (non-existent tool): strip compensatingAction, set reversible=false
   * - Safety net: dangerous=true + no valid compensation -> force reversible=false
   * - Safety net: readOnly=true -> force reversible=true
   */
  private validateCompensationTools(steps: ChainStepNode[]): ChainStepNode[] {
    return steps.map((step) => {
      let { reversible, compensatingAction } = step;
      const toolMeta = this.toolRegistry.getMetadata(step.toolName);

      // Check if compensation tool exists
      if (compensatingAction && !this.toolRegistry.has(compensatingAction.toolName)) {
        getLogger().info(
          `V2 synthesis: stripping invalid compensation for step '${step.stepId}': tool '${compensatingAction.toolName}' not found`,
        );
        compensatingAction = undefined;
        reversible = false;
      }

      // Safety net: readOnly -> always reversible
      if (toolMeta?.readOnly) {
        reversible = true;
      }

      // Safety net: dangerous + no valid compensation -> forced irreversible
      if (toolMeta?.dangerous && !compensatingAction) {
        reversible = false;
      }

      return {
        stepId: step.stepId,
        toolName: step.toolName,
        dependsOn: step.dependsOn,
        reversible,
        ...(compensatingAction ? { compensatingAction } : {}),
      };
    });
  }

  /**
   * Compute isFullyReversible from validated steps.
   * True only if ALL steps have reversible=true.
   */
  private computeIsFullyReversible(steps: ChainStepNode[]): boolean {
    return steps.every((step) => step.reversible);
  }

  /**
   * Build tool registry context string listing available tool names
   * with their dangerous/readOnly flags for the LLM prompt.
   */
  private buildToolRegistryContext(toolNames: string[]): string {
    const lines = ["", "Available tools for compensation:"];
    for (const name of toolNames) {
      const meta = this.toolRegistry.getMetadata(name);
      if (meta) {
        const flags: string[] = [];
        if (meta.dangerous) flags.push("dangerous");
        if (meta.readOnly) flags.push("readOnly");
        lines.push(`  - ${name}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`);
      } else {
        lines.push(`  - ${name}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Call LLM to generate chain metadata from candidate data.
   * Returns parsed+validated output with version indicator, or null on failure.
   */
  private async callLLM(
    candidate: CandidateChain,
  ): Promise<{ output: LLMChainOutput | LLMChainOutputV2; isV2: boolean } | null> {
    if (!this.provider) return null;

    const userMessage = this.buildUserMessage(candidate);

    try {
      const response = await this.provider.chat(
        SYNTHESIS_SYSTEM_PROMPT,
        [{ role: "user" as const, content: userMessage }],
        [],
      );

      return this.parseLLMOutput(response.text);
    } catch {
      return null;
    }
  }

  /**
   * Build user message with candidate data for LLM.
   * Includes tool registry context with dangerous/readOnly flags.
   */
  private buildUserMessage(candidate: CandidateChain): string {
    const lines = [
      `Tool sequence: ${candidate.toolNames.join(" -> ")}`,
      `Occurrences: ${candidate.occurrences}`,
      `Success count: ${candidate.successCount}`,
      `Success rate: ${computeSuccessRate(candidate).toFixed(2)}`,
    ];

    if (candidate.sampleSteps.length > 0) {
      lines.push("");
      lines.push("Sample executions:");
      for (let s = 0; s < candidate.sampleSteps.length; s++) {
        lines.push(`  Sample ${s + 1}:`);
        for (const step of candidate.sampleSteps[s]!) {
          lines.push(
            `    ${step.toolName}: input=${sanitizeSecrets(safeStringify(step.input))}`,
          );
        }
      }
    }

    // Append tool registry context for V2 compensation
    lines.push(this.buildToolRegistryContext(candidate.toolNames));

    return lines.join("\n");
  }

  /**
   * Parse and validate LLM output.
   * Tries V2 schema first (with steps + isFullyReversible), falls back to V1.
   */
  private parseLLMOutput(
    text: string,
  ): { output: LLMChainOutput | LLMChainOutputV2; isV2: boolean } | null {
    // Try V2 first
    const v2 = parseLLMJsonOutput(text, LLMChainOutputV2Schema);
    if (v2) {
      return { output: v2, isV2: true };
    }

    // Fall back to V1
    const v1 = parseLLMJsonOutput(text, LLMChainOutputSchema);
    if (v1) {
      return { output: v1, isV2: false };
    }

    return null;
  }
}
