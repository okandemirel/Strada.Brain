/**
 * ChainSynthesizer -- LLM-based chain metadata generation and CompositeTool factory
 *
 * Takes candidate chains from ChainDetector, uses LLM to generate names,
 * descriptions, and parameter mappings, then creates instincts and registers
 * composite tools.
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
  LLMChainOutput,
} from "./chain-types.js";
import { LLMChainOutputSchema, computeSuccessRate, computeCompositeMetadata, parseLLMJsonOutput, safeStringify } from "./chain-types.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";
import { CompositeTool } from "./composite-tool.js";
import { createInstinctId, CONFIDENCE_THRESHOLDS } from "../types.js";
import type { Instinct, TrajectoryId } from "../types.js";
import type { NormalizedScore, TimestampMs } from "../../types/index.js";

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

Respond ONLY with JSON:
{"name": "...", "description": "...", "parameterMappings": [...], "inputSchema": {...}}`;

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
   * 2. Call LLM to generate metadata
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
        const llmOutput = await this.callLLM(candidate);
        if (!llmOutput) continue;

        // Prevent LLM-generated names from shadowing existing non-composite tools
        const existingMeta = this.toolRegistry.getMetadata(llmOutput.name);
        if (existingMeta && existingMeta.category !== "composite") continue;

        // Build chain metadata from LLM output + candidate data
        const successRate = computeSuccessRate(candidate);

        const chainMetadata: ChainMetadata = {
          toolSequence: candidate.toolNames,
          parameterMappings: llmOutput.parameterMappings,
          successRate,
          occurrences: candidate.occurrences,
        };

        // Create instinct with confidence capped at MAX_INITIAL
        const instinctId = createInstinctId();
        const confidence = Math.min(
          successRate,
          CONFIDENCE_THRESHOLDS.MAX_INITIAL,
        );

        const now = Date.now();
        const instinct: Instinct = {
          id: instinctId,
          name: llmOutput.name,
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

        // Create CompositeTool
        const tool = new CompositeTool(
          {
            name: llmOutput.name,
            description: llmOutput.description,
            inputSchema: llmOutput.inputSchema ?? {},
            chainMetadata,
          },
          this.toolRegistry,
          this.eventBus,
        );

        // Register with metadata inheriting confirmation gates from component tools
        const toolMeta = computeCompositeMetadata(
          candidate.toolNames.map((name) => this.toolRegistry.getMetadata(name)),
        );
        this.toolRegistry.registerOrUpdate(tool, toolMeta);

        // Emit chain:detected event
        this.eventBus.emit("chain:detected", {
          chainName: llmOutput.name,
          toolSequence: candidate.toolNames,
          occurrences: candidate.occurrences,
          successRate,
          instinctId: instinctId as string,
          timestamp: now,
        });

        created.push(tool);
      } catch {
        // LLM failure for one candidate should not prevent others
        continue;
      }
    }

    return created;
  }

  /**
   * Call LLM to generate chain metadata from candidate data.
   * Returns parsed+validated output or null on failure.
   */
  private async callLLM(
    candidate: CandidateChain,
  ): Promise<LLMChainOutput | null> {
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

    return lines.join("\n");
  }

  /** Parse and validate LLM output against LLMChainOutputSchema */
  private parseLLMOutput(text: string): LLMChainOutput | null {
    return parseLLMJsonOutput(text, LLMChainOutputSchema);
  }
}
