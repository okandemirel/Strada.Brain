/**
 * Task Decomposer
 *
 * LLM-based subtask breakdown for complex prompts.
 * Uses heuristic pre-check (shouldDecompose) to avoid LLM calls for simple requests,
 * then decomposes complex tasks into 3-8 ordered subtasks via the AI provider.
 *
 * Gracefully degrades: if no provider is set or the LLM call fails,
 * returns the original prompt as a single task.
 */

import type { IAIProvider } from "../agents/providers/provider.interface.js";

// Patterns that indicate a complex, multi-step request
const COMPLEXITY_INDICATORS = [
  /\band\b.*\band\b/i, // "X and Y and Z"
  /create.*(?:with|including)/i, // "create X with Y"
  /(?:first|then|after|finally)/i, // sequential instructions
  /(?:module|system|feature|component).*(?:test|spec)/i, // feature + tests
  /\d+\s*(?:file|class|component|test)/i, // numbered items
];

// Patterns that indicate a simple, single-step request
const SIMPLE_PATTERNS = [
  /^(?:read|show|display|list|find|search|check|get)\b/i,
  /^(?:build|run|test|compile|lint)\b/i,
  /^(?:fix|update|change|rename|delete|remove)\s+(?:the\s+)?(?:one|single|a)\b/i,
];

const DECOMPOSE_PROMPT = `You are a task decomposer for a Unity C# development assistant.

Given a complex task, break it into ordered subtasks. Each subtask should be independently executable and verifiable.

Rules:
- Each subtask = one logical unit of work (create a file, modify a method, run a test)
- Order matters: dependencies first
- Always end with verification (build, test)
- Keep it concise: 3-8 subtasks for most tasks

Respond ONLY with JSON:
{"subtasks": ["subtask 1 description", "subtask 2 description", ...]}`;

export class TaskDecomposer {
  constructor(private readonly provider?: IAIProvider) {}

  /**
   * Heuristic check: should this prompt be decomposed into subtasks?
   * Returns true for complex multi-step requests, false for simple ones.
   */
  shouldDecompose(prompt: string): boolean {
    // Too short to be complex
    if (prompt.length < 30) return false;

    // Matches a known simple pattern — skip decomposition
    if (SIMPLE_PATTERNS.some((p) => p.test(prompt))) return false;

    // Matches a complexity indicator — decompose
    return COMPLEXITY_INDICATORS.some((p) => p.test(prompt));
  }

  /**
   * Decompose a complex prompt into ordered subtasks using the LLM.
   * Falls back to returning the original prompt as a single task on any failure.
   */
  async decompose(prompt: string): Promise<string[]> {
    if (!this.provider) return [prompt];

    try {
      const response = await this.provider.chat(
        DECOMPOSE_PROMPT,
        [{ role: "user", content: `Decompose this task:\n\n${prompt}` }],
        [],
      );

      // Strip markdown code fences if present (LLMs sometimes wrap JSON)
      let text = response.text.trim();
      const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
      if (fenceMatch?.[1]) {
        text = fenceMatch[1].trim();
      }

      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        return parsed.subtasks;
      }
      return [prompt];
    } catch {
      return [prompt];
    }
  }
}
