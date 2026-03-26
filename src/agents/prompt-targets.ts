import { COMPILABLE_EXT } from "./autonomy/constants.js";

const BACKTICK_TARGET_RE = /`([^`]+)`/g;
const PROJECT_PATH_FRAGMENT_RE =
  /\b(?:Assets|Packages|ProjectSettings|Temp|Library|Logs|Resources)\b(?:\/[^\s`"'.,;:!?()]+)*/g;
const FILE_NAME_RE =
  /\b[\w.-]+\.(?:cs|md|json|txt|asset|meta|prefab|unity|asmdef|ts|tsx|js|jsx|py|sh|log|tmp)\b/g;

const PROJECT_ROOTS = new Set([
  "Assets",
  "Packages",
  "ProjectSettings",
  "Temp",
  "Library",
  "Logs",
  "Resources",
]);

const EPHEMERAL_ROOTS = new Set([
  "Temp",
  "Library",
  "Logs",
]);

type PromptTargetKind =
  | "ephemeral_root"
  | "compilable"
  | "non_compilable_file"
  | "project_path"
  | "unknown";

export interface PromptTargetProfile {
  readonly targets: readonly string[];
  readonly hasExplicitTargets: boolean;
  readonly isBoundedTargetSet: boolean;
  readonly hasEphemeralRootTarget: boolean;
  readonly allTargetsNonCompilable: boolean;
  readonly hasCompilableTarget: boolean;
}

export function extractPromptTargets(prompt: string, limit = 6): string[] {
  const matches = new Set<string>();
  const trimmed = prompt.trim();

  for (const match of trimmed.matchAll(BACKTICK_TARGET_RE)) {
    const value = match[1]?.trim();
    if (value) {
      matches.add(value);
    }
  }

  for (const match of trimmed.matchAll(PROJECT_PATH_FRAGMENT_RE)) {
    const value = match[0]?.trim();
    if (value) {
      matches.add(value);
    }
  }

  for (const match of trimmed.matchAll(FILE_NAME_RE)) {
    const value = match[0]?.trim();
    if (value) {
      matches.add(value);
    }
  }

  return [...matches].slice(0, limit);
}

export function analyzePromptTargets(prompt: string, limit = 6): PromptTargetProfile {
  const targets = extractPromptTargets(prompt, limit);
  const kinds = targets.map(classifyPromptTarget);
  const hasCompilableTarget = kinds.includes("compilable");

  return {
    targets,
    hasExplicitTargets: targets.length > 0,
    isBoundedTargetSet: targets.length > 0 && targets.length <= 3,
    hasEphemeralRootTarget: kinds.includes("ephemeral_root"),
    allTargetsNonCompilable: targets.length > 0 && !hasCompilableTarget,
    hasCompilableTarget,
  };
}

export function buildExplicitTargetExecutionDirective(prompt: string): string {
  const profile = analyzePromptTargets(prompt);
  if (!profile.hasExplicitTargets) {
    return "";
  }

  const lines = [
    "## Execution Priority",
    `The user named explicit targets: ${profile.targets.join(", ")}`,
    "Act on those exact targets before any broader repository audit or exploratory inspection.",
    "Preserve project-relative paths exactly as written. Do not reinterpret project paths like `Temp/...` as absolute OS paths like `/tmp/...` unless the user explicitly asked for an absolute path.",
    "When the request is a small direct file operation on a named target, use tools on that target immediately instead of starting with broad project analysis.",
    "Do not stop on a plan, checklist, or progress memo after a direct target operation. Execute the target action, then return the concrete outcome for that exact target.",
  ];

  if (profile.hasEphemeralRootTarget && profile.allTargetsNonCompilable) {
    lines.push(
      "These targets are project-local ephemeral artifacts. Do not widen verification to repository-wide build, test, or quality checks unless you also changed compilable source/config files.",
      "For ephemeral target tasks, verify completion by observing the exact target operation and surfacing the concrete result.",
    );
  }

  return lines.join("\n");
}

export function shouldDeferRawBoundaryForDirectTarget(params: {
  prompt: string;
  touchedFileCount: number;
  hasCompilableChanges: boolean;
}): boolean {
  const profile = analyzePromptTargets(params.prompt);
  if (!profile.hasExplicitTargets || !profile.isBoundedTargetSet) {
    return false;
  }
  if (!profile.hasEphemeralRootTarget || !profile.allTargetsNonCompilable || profile.hasCompilableTarget) {
    return false;
  }
  return params.touchedFileCount > 0 && !params.hasCompilableChanges;
}

function classifyPromptTarget(target: string): PromptTargetKind {
  const normalized = target.trim().replace(/\\/g, "/");
  if (!normalized) {
    return "unknown";
  }

  const root = normalized.split("/", 1)[0] ?? "";
  if (EPHEMERAL_ROOTS.has(root)) {
    return "ephemeral_root";
  }

  const extension = extractExtension(normalized);
  if (extension && COMPILABLE_EXT.has(extension)) {
    return "compilable";
  }

  if (extension) {
    return "non_compilable_file";
  }

  if (PROJECT_ROOTS.has(root)) {
    return "project_path";
  }

  return "unknown";
}

function extractExtension(target: string): string | null {
  const slashIndex = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  const fileName = slashIndex >= 0 ? target.slice(slashIndex + 1) : target;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return null;
  }
  return fileName.slice(dotIndex).toLowerCase();
}
