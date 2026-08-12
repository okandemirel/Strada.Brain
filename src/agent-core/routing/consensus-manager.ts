/**
 * Consensus Manager
 *
 * Multi-provider verification triggered by low confidence.
 * Strategies: review (ask second provider "is this correct?") or
 * re-execute (same prompt to different provider, compare).
 *
 * Graceful degradation: 1 provider = skip entirely.
 */

import type { IAIProvider, ProviderResponse } from "../../agents/providers/provider.interface.js";
import type { TaskClassification, OriginalOutput, ConsensusResult, ConsensusStrategy } from "./routing-types.js";
import { getLogger } from "../../utils/logger.js";

export interface ConsensusConfig {
  mode: "auto" | "critical-only" | "always" | "disabled";
  threshold: number;       // 0.0-1.0
  maxProviders: number;    // Max providers to consult
  /** Per-review-call hard timeout (ms). A hung reviewer must fail CLOSED, not block
   *  the turn forever. 0 disables the timeout. */
  reviewTimeoutMs: number;
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  mode: "auto",
  threshold: 0.5,
  maxProviders: 3,
  reviewTimeoutMs: 60_000,
};

/** Strip markdown code fences so a fenced JSON verdict still parses. */
function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
}

/**
 * Scan TEXT for balanced, string/escape-aware {...} objects and return the verdict boolean
 * carried by the first of KEYS found on a TOP-LEVEL object. Only top-level objects count:
 * once an object JSON-parses, the scan skips PAST it rather than descending, so a nested
 * {"approved":true} inside a rejection's reasoning cannot flip the verdict. If two top-level
 * objects carry conflicting verdicts it fails CLOSED (returns false). Returns undefined when
 * no top-level object carries any key (the caller then falls back to keyword scanning).
 * String-aware counting means braces inside reasoning text (e.g. "the {component} is wrong")
 * don't corrupt the scan.
 */
/**
 * Shape requested from a reviewer that supports constrained decoding.
 *
 * The keys match what extractJsonVerdict already looks for, so a schema-capable
 * provider and a prose-only one land in the same parser — the schema removes
 * the digging, it does not create a second code path. `additionalProperties`
 * must be false and every property listed in `required` or OpenAI rejects the
 * schema outright rather than downgrading to a hint.
 */
const VERDICT_SCHEMA = {
  name: "consensus_verdict",
  schema: {
    type: "object",
    properties: {
      approved: { type: "boolean", description: "true if the work under review is correct" },
      reason: { type: "string", description: "one or two sentences justifying the verdict" },
    },
    required: ["approved", "reason"],
    additionalProperties: false,
  },
} as const;

function extractJsonVerdict(
  text: string,
  keys: readonly string[],
): { verdict: boolean | undefined; sawObject: boolean } {
  let verdict: boolean | undefined;
  let sawObject = false;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i += 1; continue; }
    // Find this object's matching close brace (string/escape-aware).
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) { i += 1; continue; } // no balanced close from here — keep scanning
    try {
      const parsed: unknown = JSON.parse(text.slice(i, end + 1));
      if (parsed && typeof parsed === "object") {
        sawObject = true;
        for (const key of keys) {
          if (key in parsed) {
            const value = Boolean((parsed as Record<string, unknown>)[key]);
            if (verdict !== undefined && verdict !== value) {
              return { verdict: false, sawObject: true }; // conflicting verdicts → fail closed
            }
            verdict = value;
            break;
          }
        }
        i = end + 1; // top-level object consumed — skip past it (never descend into nesting)
        continue;
      }
    } catch { /* not valid JSON — resume at i+1 to find JSON embedded in prose */ }
    i += 1;
  }
  return { verdict, sawObject };
}

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
      let result: ConsensusResult;
      if (strategy === "review") {
        result = await this.reviewStrategy(params);
      } else {
        result = await this.reExecuteStrategy(params);
      }
      try {
        const { LearningMetrics } = await import("../../learning/learning-metrics.js");
        LearningMetrics.getInstance().recordConsensusResult({
          agreed: result.agreed,
          strategy: result.strategy,
          reasoning: result.reasoning ?? "",
        });
      } catch { /* non-fatal */ }
      return result;
    } catch (error) {
      this.logger.error("Consensus verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fail closed: a broken review path must not silently approve.
      return {
        agreed: false,
        strategy,
        originalProvider: params.originalProvider,
        reasoning: "Consensus failed — manual review required",
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

    const response = await this.chatWithTimeout(
      params.reviewProvider,
      "You are a code review agent. Evaluate the proposed action for correctness and safety.",
      reviewPrompt,
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
   * Re-execute strategy: same prompt to different provider, compare structurally.
   * More expensive but more reliable — actually compares both outputs.
   */
  private async reExecuteStrategy(params: {
    originalOutput: OriginalOutput;
    originalProvider: string;
    reviewProvider: IAIProvider;
    prompt: string;
    task: TaskClassification;
  }): Promise<ConsensusResult> {
    const response = await this.chatWithTimeout(
      params.reviewProvider,
      "You are a helpful AI assistant.",
      params.prompt,
    );

    const originalHasTools = (params.originalOutput.toolCalls?.length ?? 0) > 0;
    const secondHasTools = (response.toolCalls?.length ?? 0) > 0;

    // Structural check 1: tool usage agreement
    if (originalHasTools !== secondHasTools) {
      return {
        agreed: false,
        strategy: "re-execute",
        originalProvider: params.originalProvider,
        reviewProvider: params.reviewProvider.name ?? "unknown",
        reasoning: "Providers disagree on approach (tools vs text)",
      };
    }

    // Structural check 2: if both use tools, compare tool names
    if (originalHasTools && secondHasTools) {
      const originalTools = new Set(params.originalOutput.toolCalls!.map(tc => tc.name));
      const secondTools = new Set((response.toolCalls ?? []).map(tc => (tc as { name: string }).name));
      const overlap = [...originalTools].filter(t => secondTools.has(t)).length;
      const total = new Set([...originalTools, ...secondTools]).size;
      const toolAgreement = total > 0 ? overlap / total : 1;

      return {
        agreed: toolAgreement >= 0.5, // At least half the tools overlap
        strategy: "re-execute",
        originalProvider: params.originalProvider,
        reviewProvider: params.reviewProvider.name ?? "unknown",
        reasoning: `Tool agreement: ${Math.round(toolAgreement * 100)}% (${overlap}/${total} tools overlap)`,
      };
    }

    // Structural check 3: both text — compare by asking reviewer to compare
    const comparisonPrompt = [
      "Compare these two responses to the same task. Do they agree on the approach?",
      "",
      `Task: ${params.prompt.slice(0, 300)}`,
      "",
      `Response A: ${params.originalOutput.text?.slice(0, 500) ?? "(empty)"}`,
      `Response B: ${response.text?.slice(0, 500) ?? "(empty)"}`,
      "",
      'Respond with exactly: {"agreed": true, "reasoning": "..."} or {"agreed": false, "reasoning": "..."}',
    ].join("\n");

    const comparison = await this.chatWithTimeout(
      params.reviewProvider,
      "You compare AI responses for agreement.",
      comparisonPrompt,
    );

    const agreed = this.parseApproval(comparison.text);
    return {
      agreed,
      strategy: "re-execute",
      originalProvider: params.originalProvider,
      reviewProvider: params.reviewProvider.name ?? "unknown",
      reasoning: comparison.text?.slice(0, 500) ?? "Comparison complete",
    };
  }

  /**
   * Run a single review provider.chat under a hard timeout. A reviewer that stalls
   * (uncredited/misconfigured endpoint) would otherwise hang the whole turn — the
   * verify() catch only fires on a thrown error, never on an indefinitely-pending
   * promise. On timeout we throw so verify() fails CLOSED ("manual review required").
   */
  private async chatWithTimeout(
    provider: IAIProvider,
    systemPrompt: string,
    content: string,
  ): Promise<ProviderResponse> {
    const messages = [{ role: "user" as const, content }];
    // Ask for a schema-constrained verdict. Providers that support constrained
    // decoding return guaranteed-parseable JSON instead of a verdict buried in
    // prose; the ones that do not ignore the field, which is why
    // parseApproval's brace-scanner and keyword fallback stay exactly as they
    // were. This narrows how often those fallbacks have to fire — it does not
    // replace them, and it must not, because a schema constrains the shape of
    // the reply and says nothing about whether the verdict inside is sound.
    const callOptions = { responseSchema: VERDICT_SCHEMA };
    const ms = this.config.reviewTimeoutMs;
    if (!ms || ms <= 0) {
      return provider.chat(systemPrompt, messages, [], callOptions);
    }
    // Request cancellation of the underlying call on timeout instead of merely abandoning
    // it: providers that thread `signal` into fetch abort the stalled request rather than
    // leaving it open until their own internal timeout. The race rejects regardless of
    // whether the provider honors the signal, so the turn always fails CLOSED (verify()'s
    // catch turns this into "manual review required").
    const controller = new AbortController();
    const chat = provider.chat(systemPrompt, messages, [], { ...callOptions, signal: controller.signal });
    // If the timeout wins the race the abandoned chat still settles later; swallow its
    // (abort) rejection on a side chain so Node logs no unhandled rejection.
    chat.catch(() => { /* superseded by the timeout below */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chat,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Consensus review timed out after ${ms}ms`));
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseApproval(text: string | null | undefined): boolean {
    if (!text) return false;
    const cleaned = stripCodeFences(text).trim();

    // Prefer a real JSON verdict: a TOP-LEVEL {...} object carrying "approved"/"agreed".
    // Top-level-only + conflict-fail-closed means neither a nested affirmative in the
    // reasoning nor an earlier discarded attempt can flip a rejection to approval.
    const { verdict, sawObject } = extractJsonVerdict(cleaned, ["approved", "agreed"]);
    if (verdict !== undefined) return verdict;
    // The reviewer emitted parseable JSON but no top-level verdict key — ambiguous
    // structured output. Fail CLOSED rather than fuzzy-matching a stray "approved"
    // substring buried inside that JSON (e.g. in a nested object), which would fail-OPEN.
    if (sawObject) return false;

    // No JSON at all — keyword fallback on prose, fail-closed, negatives first.
    // "correct" is intentionally NOT a positive keyword: "incorrect" / "not correct"
    // contain it and would fail-OPEN a rejection through the positive branch.
    const lower = cleaned.toLowerCase();
    if (
      lower.includes("not approved") || lower.includes("reject") || lower.includes("disagree")
      || lower.includes("do not agree") || lower.includes("don't agree")
      || lower.includes("not correct") || lower.includes("incorrect")
    ) {
      return false;
    }
    if (lower.includes("approved") || lower.includes("agree")) {
      return true;
    }

    return false; // Fail-closed default
  }
}
