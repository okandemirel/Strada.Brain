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

    // Length-based tiers, and the ONLY input to whether a request takes the
    // supervisor path: Orchestrator.shouldActivateSupervisor returns
    // `classification.complexity === "complex"` and nothing else, so a request
    // of 120 characters or more pays a goal-decomposition call and a shorter one
    // does not. A previous version of this comment claimed the opposite — that
    // complexity does not gate supervisor activation — and that claim was read,
    // believed, and used to rule the classifier out as the cause of a one-line
    // request being fanned into a seven-node goal tree, which is what it had
    // done. See task-classifier-gating.test.ts, which pins the relationship.
    //
    // 120 characters is a crude proxy for "this is several pieces of work" and
    // it is kept deliberately, not for lack of alternatives. The obvious
    // replacement — counting the files or symbols a request names — scores zero
    // on exactly the prose requests that most need decomposing, and a hard
    // length veto would permanently deny the supervisor to a short but genuinely
    // large request ("refactor the auth module"). What made the old behaviour
    // expensive was not this line: it was that a decomposition returning a
    // single goal still forced the whole supervisor apparatus. That is fixed
    // where the answer is known (goals/tree-shape.ts), which leaves this as a
    // pre-filter deciding only whether to pay ONE decomposition call — a job a
    // cheap heuristic can honestly do.
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
