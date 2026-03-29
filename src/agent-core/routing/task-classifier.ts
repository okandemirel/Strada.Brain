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

    // Short question heuristic
    if (trimmed.length < 50 && trimmed.endsWith("?")) {
      return "simple-question";
    }

    for (const { pattern, type } of TYPE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return type;
      }
    }

    return "code-generation";
  }

  private detectComplexity(prompt: string): TaskComplexity {
    const trimmed = prompt.trim();
    const len = trimmed.length;

    if (len < 20) return "trivial";

    // Structural complexity signals (content-based, not length-based)
    const andCount = (trimmed.match(/\band\b/gi) ?? []).length;
    const hasNumberedList = /\d+[.)]\s/m.test(trimmed);
    const hasMultipleSteps = /(?:first|then|after|finally|next|step\s*\d)/i.test(trimmed);
    const commaClauseCount = trimmed.split(/,/).length;
    const hasMultipleTasks = andCount >= 3 || hasNumberedList;
    const hasLongFeatureList = commaClauseCount >= 5 && len >= 200;

    // Complex: multiple explicit tasks/steps regardless of length
    if (hasMultipleTasks) return "complex";

    // Long prompt with many comma-separated items → complex (feature lists, multi-requirement specs)
    if (hasLongFeatureList) return "complex";

    // Long AND has structural markers → complex
    if (len >= 400 && hasMultipleSteps) return "complex";

    if (len < 80) return "simple";

    // Moderate-length without structural markers → moderate (not complex)
    return "moderate";
  }

  private detectCriticality(
    type: TaskType,
    complexity: TaskComplexity,
  ): TaskCriticality {
    if (type === "destructive-operation") return "critical";
    if (type === "planning" && complexity === "complex") return "high";
    if (type === "simple-question" && complexity === "trivial") return "low";
    return "medium";
  }
}
