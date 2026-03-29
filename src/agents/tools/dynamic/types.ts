// ---------------------------------------------------------------------------
// Dynamic Tool & Skill Creation — Type Definitions
// ---------------------------------------------------------------------------

/** Execution strategy for dynamic tools. */
export type DynamicToolStrategy = "shell" | "composite";

/**
 * A single step in a composite dynamic tool.
 * Each step calls an existing registered tool with mapped parameters.
 */
export interface CompositeStep {
  /** Name of the existing tool to call. */
  tool: string;
  /** Parameter mapping — values can be literals or `{{paramName}}` / `{{prev.outputAs}}` references. */
  params: Record<string, string>;
  /** Optional name to reference this step's output in subsequent steps. */
  outputAs?: string;
}

/**
 * Specification for creating a dynamic tool at runtime.
 */
export interface DynamicToolSpec {
  /** Tool name (will be prefixed with `dynamic_`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema properties for the tool's input parameters. */
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required?: boolean;
    enum?: string[];
  }>;
  /** Execution strategy. */
  strategy: DynamicToolStrategy;

  // ── Shell strategy fields ──────────────────────────────────────────────
  /** Command template with `{{paramName}}` placeholders. Required for shell strategy. */
  command?: string;
  /** Execution timeout in milliseconds (default 30 000, max 60 000). */
  timeout?: number;

  // ── Composite strategy fields ──────────────────────────────────────────
  /** Ordered list of tool calls. Required for composite strategy. */
  steps?: CompositeStep[];
}

/**
 * Specification for creating a persistent skill on disk.
 */
export interface DynamicSkillSpec {
  /** Skill name (used as directory name). */
  name: string;
  /** Semantic version string. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** SKILL.md body content (markdown). */
  content: string;
  /** Optional author attribution. */
  author?: string;
  /** Optional capability tags. */
  capabilities?: string[];
}

/** Tracks metadata for a dynamically registered tool. */
export interface DynamicToolRecord {
  spec: DynamicToolSpec;
  registeredAt: Date;
  callCount: number;
}
