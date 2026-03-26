import type { AgentState } from "../agent-state.js";
import { extractPromptTargets as extractPromptTargetsHelper } from "../prompt-targets.js";
import { MUTATION_TOOLS, isVerificationToolName } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BehavioralSnapshot {
  readonly prompt: string;
  readonly promptTargets: readonly string[];
  readonly currentPhase: string;
  readonly totalStepCount: number;
  readonly mutationStepCount: number;
  readonly inspectionStepCount: number;
  readonly verificationStepCount: number;
  readonly consecutiveTextOnlyGates: number;
  readonly reflectionCount: number;
  readonly failedApproachCount: number;
  readonly consecutiveErrors: number;
  readonly touchedFileCount: number;
  readonly hasActivePlan: boolean;
  readonly lastToolName: string | null;
  readonly timeSinceLastMutationMs: number;
  readonly draftExcerpt: string;
}

export interface ProgressAssessment {
  readonly verdict: "progressing" | "stuck";
  readonly confidence: "high" | "medium" | "low";
  readonly directive?: string;
}

export interface BuildBehavioralSnapshotParams {
  readonly prompt: string;
  readonly state: AgentState;
  readonly touchedFileCount: number;
  readonly consecutiveTextOnlyGates: number;
  readonly taskStartedAtMs: number;
  readonly draftExcerpt: string;
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

const INSPECTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "file_read", "list_directory", "grep_search", "find_file",
  "strada_search_api", "get_project_info",
]);

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export function buildBehavioralSnapshot(params: BuildBehavioralSnapshotParams): BehavioralSnapshot {
  const { state } = params;
  let mutationStepCount = 0;
  let inspectionStepCount = 0;
  let verificationStepCount = 0;

  for (const step of state.stepResults) {
    if (MUTATION_TOOLS.has(step.toolName)) {
      mutationStepCount++;
    } else if (isVerificationToolName(step.toolName)) {
      verificationStepCount++;
    } else if (INSPECTION_TOOL_NAMES.has(step.toolName)) {
      inspectionStepCount++;
    }
  }

  let timeSinceLastMutationMs: number;
  const now = Date.now();
  let lastMutationTs: number | null = null;
  for (let i = state.stepResults.length - 1; i >= 0; i--) {
    const step = state.stepResults[i];
    if (step && MUTATION_TOOLS.has(step.toolName)) {
      lastMutationTs = step.timestamp;
      break;
    }
  }
  timeSinceLastMutationMs = lastMutationTs !== null
    ? now - lastMutationTs
    : now - params.taskStartedAtMs;

  return {
    prompt: params.prompt.slice(0, 200),
    promptTargets: extractPromptTargets(params.prompt),
    currentPhase: state.phase,
    totalStepCount: state.stepResults.length,
    mutationStepCount,
    inspectionStepCount,
    verificationStepCount,
    consecutiveTextOnlyGates: params.consecutiveTextOnlyGates,
    reflectionCount: state.reflectionCount,
    failedApproachCount: state.failedApproaches.length,
    consecutiveErrors: state.consecutiveErrors,
    touchedFileCount: params.touchedFileCount,
    hasActivePlan: state.plan !== null,
    lastToolName: state.stepResults.at(-1)?.toolName ?? null,
    timeSinceLastMutationMs,
    draftExcerpt: params.draftExcerpt.slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const PROGRESS_ASSESSMENT_SYSTEM_PROMPT = `You are Strada Brain's progress assessor.
Given a behavioral snapshot of an executing agent, determine whether it is making meaningful progress toward the user's goal or is stuck in a repetitive analysis/clarification loop.

"progressing" means: the agent has recently used tools to read files, write code, run commands, or otherwise interact with the project. Text-only responses that analyze or plan DO NOT count as progress unless the agent has also executed tools in the same session.

"stuck" means ANY of these:
- consecutiveTextOnlyGates >= 3 with zero mutations and zero inspections
- The agent keeps generating analysis, plans, or clarification text without calling any tools
- The same analysis or clarification pattern repeats across gates
- The agent has context to act but keeps discussing instead of using tools

CRITICAL: An agent that has never used a single tool and has 3+ consecutive text-only gates is STUCK, not "in an early exploration phase". Exploration requires tool calls (file_read, grep_search, etc).

If the user goal contains a concrete file name, directory, path fragment, or other explicit target, preserve that target in your directive. Do NOT invent a different absolute OS path unless the user explicitly asked for that path.

Return JSON only:
{"verdict":"progressing"|"stuck","confidence":"high"|"medium"|"low","directive":"one concrete next action if stuck"}`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildProgressAssessmentRequest(snapshot: BehavioralSnapshot): string {
  return [
    `User goal: ${snapshot.prompt}`,
    `Prompt targets: ${snapshot.promptTargets.length > 0 ? snapshot.promptTargets.join(", ") : "none detected"}`,
    `Phase: ${snapshot.currentPhase}`,
    `Steps: ${snapshot.totalStepCount} total (${snapshot.mutationStepCount} mutations, ${snapshot.inspectionStepCount} inspections, ${snapshot.verificationStepCount} verifications)`,
    `Consecutive text-only gates: ${snapshot.consecutiveTextOnlyGates}`,
    `Reflections: ${snapshot.reflectionCount}, Failed approaches: ${snapshot.failedApproachCount}`,
    `Files touched: ${snapshot.touchedFileCount}`,
    `Has plan: ${snapshot.hasActivePlan}`,
    `Last tool: ${snapshot.lastToolName ?? "none"}`,
    `Time since last mutation: ${snapshot.timeSinceLastMutationMs}ms`,
    `Current draft excerpt: ${snapshot.draftExcerpt}`,
    "",
    "Is this agent making meaningful progress or stuck?",
  ].join("\n");
}

function extractPromptTargets(prompt: string): string[] {
  return extractPromptTargetsHelper(prompt, 6);
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

const VALID_VERDICTS = new Set(["progressing", "stuck"]);
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

export function parseProgressAssessment(text: string): ProgressAssessment | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(),
  ];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!VALID_VERDICTS.has(parsed.verdict as string)) continue;
      if (!VALID_CONFIDENCES.has(parsed.confidence as string)) continue;
      return {
        verdict: parsed.verdict as ProgressAssessment["verdict"],
        confidence: parsed.confidence as ProgressAssessment["confidence"],
        directive: typeof parsed.directive === "string" ? parsed.directive.slice(0, 500) : undefined,
      };
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runProgressAssessment(
  snapshot: BehavioralSnapshot,
  reviewer: {
    provider: {
      chat(
        system: string,
        messages: Array<{ role: string; content: string }>,
        tools: unknown[],
      ): Promise<{ text: string; usage?: unknown }>;
    };
    providerName: string;
  },
  deps: {
    recordAuxiliaryUsage: (providerName: string, usage: unknown, handler?: unknown) => void;
    usageHandler?: unknown;
  },
): Promise<ProgressAssessment | null> {
  try {
    const response = await reviewer.provider.chat(
      PROGRESS_ASSESSMENT_SYSTEM_PROMPT,
      [{ role: "user", content: buildProgressAssessmentRequest(snapshot) }],
      [],
    );
    deps.recordAuxiliaryUsage(reviewer.providerName, response.usage, deps.usageHandler);
    return parseProgressAssessment(response.text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gate builders
// ---------------------------------------------------------------------------

export function buildDirectiveGate(assessment: ProgressAssessment): string {
  const directive = assessment.directive?.trim();
  const lines = [
    "[PROGRESS ASSESSMENT] You are stuck in an analysis loop without executing tools.",
    "STOP generating text-only responses.",
  ];
  if (directive) {
    lines.push(`Required next action: ${directive}`);
    lines.push(
      "Execute that required action before any broader repository audit or exploratory inspection.",
    );
    lines.push(
      "If the directive names a concrete file, path, artifact, or command target, act on that exact target first and only broaden scope if the direct attempt fails.",
    );
  } else {
    lines.push("Use your available tools (file_read, file_write, shell, etc.) to make concrete progress on the task.");
  }
  lines.push("Do not produce another text-only analysis response.");
  return lines.join("\n\n");
}

export function buildStuckCheckpointMessage(
  prompt: string,
  assessment: ProgressAssessment,
  touchedFiles: readonly string[],
): string {
  const lines = [
    "Blocked checkpoint: The agent is stuck in a repeated analysis/clarification loop.",
    "",
    `Task: ${prompt.slice(0, 200)}`,
    `Assessment: ${assessment.verdict} (${assessment.confidence} confidence)`,
    assessment.directive ? `Suggested action: ${assessment.directive}` : "",
    "",
    `Files touched: ${touchedFiles.length > 0 ? touchedFiles.slice(0, 5).join(", ") : "(none)"}`,
    "",
    "Reason: The same clarification/internal-analysis loop is repeating, and no implementation work has started despite clear required changes.",
  ].filter(Boolean);
  return lines.join("\n");
}
