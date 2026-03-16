/**
 * Confidence Estimator
 *
 * Heuristic scoring of agent output confidence.
 * Used by ConsensusManager to decide when to seek a second opinion.
 * No LLM calls — pure computation from PAOR state.
 */

import type { TaskClassification } from "./routing-types.js";

/** Structural interface for AgentState (avoids circular import) */
interface AgentStateRef {
  readonly consecutiveErrors: number;
  readonly stepResults: readonly { readonly success: boolean }[];
  readonly iteration: number;
}

/** Cost tier mapping — higher = more expensive/capable */
const MODEL_CAPABILITY_TIER: Record<string, number> = {
  ollama: 1, groq: 2, kimi: 3, deepseek: 3, qwen: 3,
  mistral: 4, together: 4, fireworks: 4, minimax: 4,
  openai: 5, gemini: 5, claude: 6,
};

const COMPLEXITY_SCORE: Record<string, number> = {
  trivial: 1, simple: 2, moderate: 3, complex: 4,
};

export class ConfidenceEstimator {
  /**
   * Estimate confidence in the agent's output.
   * Returns 0.0 (no confidence) to 1.0 (full confidence).
   */
  estimate(context: {
    task: TaskClassification;
    providerName: string;
    agentState: AgentStateRef;
    responseLength: number;
  }): number {
    let score = 0.7; // Base confidence

    // Factor 1: Session error rate (weight 0.3)
    const totalSteps = context.agentState.stepResults.length;
    if (totalSteps > 0) {
      const errorRate = context.agentState.stepResults.filter(s => !s.success).length / totalSteps;
      score -= errorRate * 0.3;
    }

    // Factor 2: Complexity vs capability mismatch (weight 0.25)
    const complexity = COMPLEXITY_SCORE[context.task.complexity] ?? 2;
    const capability = MODEL_CAPABILITY_TIER[context.providerName] ?? 3;
    if (complexity > capability) {
      score -= (complexity - capability) * 0.08; // Mismatch penalty
    }

    // Factor 3: Consecutive errors (weight 0.25)
    if (context.agentState.consecutiveErrors >= 3) {
      score -= 0.25;
    } else if (context.agentState.consecutiveErrors >= 2) {
      score -= 0.15;
    } else if (context.agentState.consecutiveErrors >= 1) {
      score -= 0.05;
    }

    // Factor 4: Response length anomaly (weight 0.2)
    if (context.responseLength < 10) {
      score -= 0.15; // Suspiciously short
    } else if (context.responseLength > 10000 && context.task.complexity === "trivial") {
      score -= 0.10; // Over-verbose for simple task
    }

    return Math.min(1.0, Math.max(0.0, score));
  }
}
