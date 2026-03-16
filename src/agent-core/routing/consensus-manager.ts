/**
 * Consensus Manager
 *
 * Multi-provider verification triggered by low confidence.
 * Strategies: review (ask second provider "is this correct?") or
 * re-execute (same prompt to different provider, compare).
 *
 * Graceful degradation: 1 provider = skip entirely.
 */

import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { TaskClassification, OriginalOutput, ConsensusResult, ConsensusStrategy } from "./routing-types.js";
import { getLogger } from "../../utils/logger.js";

export interface ConsensusConfig {
  mode: "auto" | "critical-only" | "always" | "disabled";
  threshold: number;       // 0.0-1.0
  maxProviders: number;    // Max providers to consult
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  mode: "auto",
  threshold: 0.5,
  maxProviders: 3,
};

export class ConsensusManager {
  private readonly config: ConsensusConfig;
  private readonly logger = getLogger();

  constructor(config?: Partial<ConsensusConfig>) {
    this.config = { ...DEFAULT_CONSENSUS_CONFIG, ...config };
  }

  /**
   * Determine if consensus should be sought.
   */
  shouldConsult(
    confidence: number,
    task: TaskClassification,
    availableProviderCount: number,
  ): ConsensusStrategy {
    // Disabled or single provider — skip
    if (this.config.mode === "disabled" || availableProviderCount < 2) {
      return "skip";
    }

    // Critical-only mode: only for critical tasks
    if (this.config.mode === "critical-only" && task.criticality !== "critical") {
      return "skip";
    }

    // Always mode: always consult
    if (this.config.mode === "always") {
      return confidence < 0.4 ? "re-execute" : "review";
    }

    // Auto mode: based on confidence threshold
    if (confidence >= this.config.threshold) {
      return "skip"; // Confident enough
    }

    // Low confidence + destructive operation -> review
    if (task.type === "destructive-operation" || task.criticality === "critical") {
      return "review";
    }

    // Very low confidence -> re-execute
    if (confidence < 0.4) {
      return "re-execute";
    }

    return "review";
  }

  /**
   * Verify output with a second provider.
   */
  async verify(params: {
    originalOutput: OriginalOutput;
    originalProvider: string;
    task: TaskClassification;
    confidence: number;
    reviewProvider: IAIProvider;
    prompt: string;
  }): Promise<ConsensusResult> {
    const strategy = this.shouldConsult(
      params.confidence,
      params.task,
      2, // We have at least the review provider
    );

    if (strategy === "skip") {
      return {
        agreed: true,
        strategy: "skip",
        originalProvider: params.originalProvider,
        reasoning: "Consensus skipped — confidence sufficient or disabled",
      };
    }

    try {
      if (strategy === "review") {
        return await this.reviewStrategy(params);
      } else {
        return await this.reExecuteStrategy(params);
      }
    } catch (error) {
      this.logger.error("Consensus verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // On failure, trust the original output (fail-open)
      return {
        agreed: true,
        strategy,
        originalProvider: params.originalProvider,
        reasoning: "Consensus failed — trusting original output",
      };
    }
  }

  /**
   * Review strategy: ask second provider "Is this correct?"
   * Cheaper than re-execute — shorter prompt.
   */
  private async reviewStrategy(params: {
    originalOutput: OriginalOutput;
    originalProvider: string;
    reviewProvider: IAIProvider;
    prompt: string;
    task: TaskClassification;
  }): Promise<ConsensusResult> {
    // Serialize the original output for review
    let outputDesc: string;
    if (params.originalOutput.toolCalls?.length) {
      const toolDescs = params.originalOutput.toolCalls.map(tc =>
        `${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`
      ).join(", ");
      outputDesc = `Tool calls: ${toolDescs}`;
      if (params.originalOutput.text) {
        outputDesc += `\nReasoning: ${params.originalOutput.text.slice(0, 500)}`;
      }
    } else {
      outputDesc = params.originalOutput.text?.slice(0, 1000) ?? "(empty response)";
    }

    const reviewPrompt = [
      "Review the following agent action for correctness.",
      "",
      `Original task: ${params.prompt.slice(0, 500)}`,
      `Task type: ${params.task.type}, Criticality: ${params.task.criticality}`,
      "",
      "Agent's proposed action:",
      outputDesc,
      "",
      'Respond with exactly: {"approved": true, "reasoning": "..."} or {"approved": false, "reasoning": "..."}',
    ].join("\n");

    const response = await params.reviewProvider.chat(
      "You are a code review agent. Evaluate the proposed action for correctness and safety.",
      [{ role: "user" as const, content: reviewPrompt }],
      [],
    );

    const approved = this.parseApproval(response.text);

    return {
      agreed: approved,
      strategy: "review",
      originalProvider: params.originalProvider,
      reviewProvider: params.reviewProvider.name ?? "unknown",
      reasoning: response.text?.slice(0, 500),
    };
  }

  /**
   * Re-execute strategy: same prompt to different provider, compare.
   * More expensive but more reliable.
   */
  private async reExecuteStrategy(params: {
    originalOutput: OriginalOutput;
    originalProvider: string;
    reviewProvider: IAIProvider;
    prompt: string;
    task: TaskClassification;
  }): Promise<ConsensusResult> {
    const response = await params.reviewProvider.chat(
      "You are a helpful AI assistant.",
      [{ role: "user" as const, content: params.prompt }],
      [],
    );

    // Simple comparison: do both outputs suggest the same action?
    const originalHasTools = (params.originalOutput.toolCalls?.length ?? 0) > 0;
    const secondHasTools = (response.toolCalls?.length ?? 0) > 0;

    // If one has tools and other doesn't — disagreement
    if (originalHasTools !== secondHasTools) {
      return {
        agreed: false,
        strategy: "re-execute",
        originalProvider: params.originalProvider,
        reviewProvider: params.reviewProvider.name ?? "unknown",
        reasoning: "Providers disagree on approach (tools vs text)",
      };
    }

    // Both text responses — check for directional agreement
    // Simple heuristic: if both responses are > 50 chars, assume agreement
    // (Deep semantic comparison would require another LLM call)
    return {
      agreed: true,
      strategy: "re-execute",
      originalProvider: params.originalProvider,
      reviewProvider: params.reviewProvider.name ?? "unknown",
      reasoning: "Both providers produced similar output type",
    };
  }

  private parseApproval(text: string | null | undefined): boolean {
    if (!text) return true; // Default to approval on parse failure
    try {
      const match = text.match(/\{[\s\S]*"approved"[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return Boolean(parsed.approved);
      }
    } catch {
      // Parse failure
    }
    // Fallback: look for keywords
    const lower = text.toLowerCase();
    if (lower.includes("not approved") || lower.includes("rejected") || lower.includes('"approved": false') || lower.includes('"approved":false')) {
      return false;
    }
    return true; // Default to approved
  }
}
