/**
 * Task Classifier
 *
 * Heuristic-based classification of prompts and tool calls into
 * TaskType / TaskComplexity / TaskCriticality — NO LLM calls.
 */

import type {
  TaskClassification,
  TaskType,
  TaskComplexity,
  TaskCriticality,
} from "./routing-types.js";

/* ------------------------------------------------------------------ */
/*  Keyword patterns for task-type detection                          */
/* ------------------------------------------------------------------ */

// Type patterns use English keywords only as HINTS — they don't gate
// tool availability (write tools are always available in executor role).
// Non-English prompts fall through to the default "code-generation" type,
// which is the most permissive. The LLM handles intent in any language.
const TYPE_PATTERNS: Array<{ pattern: RegExp; type: TaskType }> = [
  {
    pattern: /\b(analyze|explain|describe|what\s+is|how\s+does)\b/i,
    type: "analysis",
  },
  {
    pattern: /\b(review|check|audit|inspect)\b/i,
    type: "code-review",
  },
  {
    pattern: /\b(fix|debug|error|fail|broken)\b|CS\d{4}/i,
    type: "debugging",
  },
  {
    pattern: /\b(refactor|restructure|reorganize|clean\s*up)\b/i,
    type: "refactoring",
  },
  { pattern: /\b(plan|architect|design|structure)\b/i, type: "planning" },
  {
    pattern: /\b(create|write|add|implement|build)\b/i,
    type: "code-generation",
  },
];

/* ------------------------------------------------------------------ */
/*  Destructive tool names                                            */
/* ------------------------------------------------------------------ */

const DESTRUCTIVE_TOOLS = new Set([
  "file_delete",
  "file_delete_directory",
  "shell_exec",
  "git_push",
]);

const WRITE_TOOLS = new Set(["file_write", "file_edit", "file_create"]);

const READ_TOOLS = new Set([
  "file_read",
  "file_list",
  "dotnet_build",
  "dotnet_test",
]);

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export class TaskClassifier {
  /**
   * Classify a user prompt into type / complexity / criticality.
   */
  classify(prompt: string): TaskClassification {
    const type = this.detectType(prompt);
    const complexity = this.detectComplexity(prompt);
    const criticality = this.detectCriticality(type, complexity);
    return { type, complexity, criticality };
  }

  /**
   * Classify a tool call into type / complexity / criticality.
   */
  classifyToolCall(
    toolName: string,
    _input?: Record<string, unknown>,
  ): TaskClassification {
    if (DESTRUCTIVE_TOOLS.has(toolName)) {
      return {
        type: "destructive-operation",
        complexity: "moderate",
        criticality: "critical",
      };
    }

    if (WRITE_TOOLS.has(toolName)) {
      return {
        type: "code-generation",
        complexity: "moderate",
        criticality: "medium",
      };
    }

    if (READ_TOOLS.has(toolName)) {
      return {
        type: "analysis",
        complexity: "simple",
        criticality: "low",
      };
    }

    // Unknown tool — default
    return {
      type: "code-generation",
      complexity: "moderate",
      criticality: "medium",
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Internals                                                       */
  /* ---------------------------------------------------------------- */

  private detectType(prompt: string): TaskType {
    const trimmed = prompt.trim();

    // Language-agnostic: trivially short messages are conversational (greetings, typos)
    // Threshold set to 20 to avoid false positives on short but real code tasks
    // like "fix main.cs" or "add a test" which need full processing.
    if (trimmed.length < 20) {
      return "conversational";
    }

    // Language-agnostic: short prompt ending with ? in any language = simple question
    if (trimmed.length < 60 && /[?？؟]$/.test(trimmed)) {
      return "simple-question";
    }

    // English keyword hints — non-English prompts fall through to
    // "code-generation" (most permissive type, all tools available)
    for (const { pattern, type } of TYPE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return type;
      }
    }

    return "code-generation";
  }

  private detectComplexity(prompt: string): TaskComplexity {
    const len = prompt.trim().length;

    // Language-agnostic: complexity is a best-effort signal for metrics
    // and phase prompts. It does NOT gate tool availability or supervisor
    // activation (those decisions use shouldDecompose + LLM).
    //
    // Simple length-based tiers — no language-specific patterns.
    // The LLM is the real judge of complexity.
    if (len < 20) return "trivial";
    if (len < 60) return "simple";
    if (len < 120) return "moderate";
    return "complex";
  }

  private detectCriticality(
    type: TaskType,
    complexity: TaskComplexity,
  ): TaskCriticality {
    if (type === "destructive-operation") return "critical";
    if (type === "planning" && complexity === "complex") return "high";
    if (type === "conversational") return "low";
    if (type === "simple-question" && complexity === "trivial") return "low";
    return "medium";
  }
}
