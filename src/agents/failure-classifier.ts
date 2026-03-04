import type { StepResult } from "./agent-state.js";

export enum FailureType {
  COMPILATION = "compilation",
  TEST = "test",
  RUNTIME = "runtime",
  ENVIRONMENT = "environment",
  LOGIC = "logic",
  UNKNOWN = "unknown",
}

export interface FailureClassification {
  readonly type: FailureType;
  readonly errorCode: string | null;
  readonly suggestion: string;
}

interface FailurePattern {
  readonly regex: RegExp;
  readonly type: FailureType;
  readonly suggestion: string;
}

const FAILURE_PATTERNS: readonly FailurePattern[] = [
  {
    regex: /CS\d{4}/,
    type: FailureType.COMPILATION,
    suggestion: "Fix the C# compilation error and rebuild.",
  },
  {
    regex: /MSB\d+/,
    type: FailureType.COMPILATION,
    suggestion: "Fix the MSBuild error and rebuild the project.",
  },
  {
    regex: /FAIL|Assert|Expected.*Actual/i,
    type: FailureType.TEST,
    suggestion: "Review test assertions and fix the failing logic.",
  },
  {
    regex: /Exception|NullReference|StackOverflow/,
    type: FailureType.RUNTIME,
    suggestion: "Debug the runtime error; check for null references and recursion.",
  },
  {
    regex: /ENOENT|EACCES|not found/i,
    type: FailureType.ENVIRONMENT,
    suggestion: "Verify file paths, permissions, and environment setup.",
  },
];

const ERROR_CODE_REGEX = /\b(CS\d{4}|MSB\d+)\b/;

export function classifyFailure(step: StepResult): FailureClassification {
  const text = step.summary;

  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.regex.test(text)) {
      const codeMatch = text.match(ERROR_CODE_REGEX);
      return {
        type: pattern.type,
        errorCode: codeMatch ? codeMatch[1] : null,
        suggestion: pattern.suggestion,
      };
    }
  }

  return {
    type: FailureType.UNKNOWN,
    errorCode: null,
    suggestion: "Inspect the error output manually to determine the cause.",
  };
}

const SAME_TYPE_REPLAN_THRESHOLD = 3;

export function shouldForceReplan(steps: readonly StepResult[]): boolean {
  if (steps.length < SAME_TYPE_REPLAN_THRESHOLD) {
    return false;
  }

  const lastN = steps.slice(-SAME_TYPE_REPLAN_THRESHOLD);
  const types = lastN.map((s) => classifyFailure(s).type);

  return types.every((t) => t === types[0]);
}
