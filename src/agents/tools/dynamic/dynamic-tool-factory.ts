// ---------------------------------------------------------------------------
// DynamicToolFactory — Creates ITool instances from DynamicToolSpec
// ---------------------------------------------------------------------------

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ITool, ToolContext, ToolExecutionResult, ToolInputSchema } from "../tool.interface.js";
import type { DynamicToolSpec, DynamicToolRecord } from "./types.js";

// NOTE: exec is used intentionally here (not execFile) because dynamic shell
// tools define command templates that may include pipes, redirections, and other
// shell syntax. All user-supplied parameters are shell-escaped via shellEscape()
// before interpolation, preventing command injection.
const execAsync = promisify(exec);

/** Tools that are too dangerous to allow inside composite chains (bypass confirmation). */
const COMPOSITE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "shell_exec", "file_write", "file_edit",
  "file_delete", "file_rename", "file_delete_directory",
  "git_commit", "git_push", "git_reset", "git_rebase",
]);

/** Maximum number of dynamic tools allowed per session. */
const MAX_DYNAMIC_TOOLS = 50;
/** Default shell command timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Absolute maximum timeout. */
const MAX_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Shell-safe parameter escaping
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe use in a shell command.
 * Wraps in single quotes and escapes any internal single quotes.
 */
function shellEscape(value: string): string {
  // Strip null bytes to prevent C-string truncation attacks that bypass escaping
  const sanitized = value.replace(/\0/g, "");
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}

/**
 * Interpolate `{{paramName}}` placeholders in a command template
 * with shell-escaped parameter values.
 */
function interpolateCommand(
  template: string,
  params: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (_match, name: string, defaultValue?: string) => {
    const raw = params[name];
    if (raw === undefined || raw === null) {
      if (defaultValue !== undefined) return shellEscape(defaultValue);
      return "''"; // empty string for missing params
    }
    return shellEscape(String(raw));
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateSpec(spec: DynamicToolSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!spec.name || typeof spec.name !== "string") {
    issues.push({ field: "name", message: "Name is required and must be a non-empty string" });
  } else if (!/^[a-z][a-z0-9_]*$/.test(spec.name)) {
    issues.push({ field: "name", message: "Name must start with a lowercase letter and contain only [a-z0-9_]" });
  }

  if (!spec.description || typeof spec.description !== "string") {
    issues.push({ field: "description", message: "Description is required" });
  }

  if (!spec.strategy || !["shell", "composite"].includes(spec.strategy)) {
    issues.push({ field: "strategy", message: "Strategy must be 'shell' or 'composite'" });
  }

  if (spec.strategy === "shell") {
    if (!spec.command || typeof spec.command !== "string") {
      issues.push({ field: "command", message: "Shell strategy requires a command template" });
    }
    if (spec.timeout !== undefined) {
      if (typeof spec.timeout !== "number" || spec.timeout < 0 || spec.timeout > MAX_TIMEOUT_MS) {
        issues.push({ field: "timeout", message: `Timeout must be 0–${MAX_TIMEOUT_MS}ms` });
      }
    }
  }

  if (spec.strategy === "composite") {
    if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
      issues.push({ field: "steps", message: "Composite strategy requires at least one step" });
    } else {
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i]!;
        if (!step.tool || typeof step.tool !== "string") {
          issues.push({ field: `steps[${i}].tool`, message: "Each step must reference a tool name" });
        }
        if (!step.params || typeof step.params !== "object") {
          issues.push({ field: `steps[${i}].params`, message: "Each step must have a params object" });
        }
      }
    }
  }

  if (spec.parameters) {
    for (let i = 0; i < spec.parameters.length; i++) {
      const p = spec.parameters[i]!;
      if (!p.name) issues.push({ field: `parameters[${i}].name`, message: "Parameter name required" });
      if (!p.type) issues.push({ field: `parameters[${i}].type`, message: "Parameter type required" });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export class DynamicToolFactory {
  private registry = new Map<string, DynamicToolRecord>();

  /** How many dynamic tools are currently registered. */
  get size(): number {
    return this.registry.size;
  }

  /** Check if a dynamic tool exists. */
  has(prefixedName: string): boolean {
    return this.registry.has(prefixedName);
  }

  /** Get record of a dynamic tool. */
  getRecord(prefixedName: string): DynamicToolRecord | undefined {
    return this.registry.get(prefixedName);
  }

  /** List all dynamic tool records. */
  listAll(): Array<{ name: string; record: DynamicToolRecord }> {
    return [...this.registry.entries()].map(([name, record]) => ({ name, record }));
  }

  /** Remove a dynamic tool record. Returns true if it existed. */
  remove(prefixedName: string): boolean {
    return this.registry.delete(prefixedName);
  }

  /**
   * Create an ITool from a DynamicToolSpec.
   *
   * @param spec The dynamic tool specification
   * @param existingToolNames Set of currently registered tool names (for conflict check)
   * @param toolLookup Function to look up existing tools by name (for composite strategy)
   * @returns The created ITool
   * @throws Error if validation fails or limits are exceeded
   */
  create(
    spec: DynamicToolSpec,
    existingToolNames: Set<string>,
    toolLookup?: (name: string) => ITool | undefined,
  ): ITool {
    // Validate spec
    const issues = validateSpec(spec);
    if (issues.length > 0) {
      throw new Error(
        `Invalid dynamic tool spec:\n${issues.map((i) => `  - ${i.field}: ${i.message}`).join("\n")}`,
      );
    }

    // Check limits
    if (this.registry.size >= MAX_DYNAMIC_TOOLS) {
      throw new Error(`Dynamic tool limit reached (${MAX_DYNAMIC_TOOLS}). Remove unused tools first.`);
    }

    // Prefix name
    const prefixedName = `dynamic_${spec.name}`;

    // Check conflicts with built-in tools and existing dynamic tools
    if (existingToolNames.has(prefixedName) || this.registry.has(prefixedName)) {
      throw new Error(`Tool '${prefixedName}' already exists. Choose a different name.`);
    }

    // Build input schema
    const params = spec.parameters ?? [];
    const inputSchema: ToolInputSchema = {
      type: "object",
      properties: Object.fromEntries(
        params.map((p) => [
          p.name,
          {
            type: p.type,
            description: p.description,
            ...(p.enum ? { enum: p.enum } : {}),
          },
        ]),
      ),
      required: params.filter((p) => p.required).map((p) => p.name),
    };

    // Build the execute function based on strategy
    const executeFn =
      spec.strategy === "shell"
        ? this.createShellExecutor(spec)
        : this.createCompositeExecutor(spec, toolLookup);

    // Track usage
    const record: DynamicToolRecord = {
      spec,
      registeredAt: new Date(),
      callCount: 0,
    };
    this.registry.set(prefixedName, record);

    const tool: ITool = {
      name: prefixedName,
      description: `[Dynamic] ${spec.description}`,
      inputSchema,
      isPlugin: true,
      metadata: {
        name: prefixedName,
        description: spec.description,
        category: "custom",
        riskLevel: spec.strategy === "shell" ? "caution" : "safe",
        isReadOnly: false,
        requiresConfirmation: spec.strategy === "shell",
        tags: ["dynamic", spec.strategy],
      },
      execute: async (input, context) => {
        record.callCount++;
        return executeFn(input, context);
      },
    };

    return tool;
  }

  // ── Shell executor ───────────────────────────────────────────────────

  private createShellExecutor(
    spec: DynamicToolSpec,
  ): (input: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult> {
    const timeout = Math.min(spec.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const commandTemplate = spec.command!;

    return async (input, context) => {
      // Block shell execution in read-only mode
      if (context.readOnly) {
        return {
          content: "Shell-strategy dynamic tools are blocked in read-only mode.",
          isError: true,
        };
      }

      const command = interpolateCommand(commandTemplate, input);

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: context.workingDirectory || context.projectPath,
          timeout,
          maxBuffer: 1024 * 1024, // 1 MB
          env: process.env,
        });

        const output = stdout.trim() || stderr.trim() || "(no output)";
        return { content: output };
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string; code?: number };
        const stderr = err.stderr?.trim() ?? "";
        const stdout = err.stdout?.trim() ?? "";
        const detail = stderr || stdout || err.message;
        return {
          content: `Command failed (exit ${err.code ?? "?"}): ${detail}`,
          isError: true,
        };
      }
    };
  }

  // ── Composite executor ───────────────────────────────────────────────

  private createCompositeExecutor(
    spec: DynamicToolSpec,
    toolLookup?: (name: string) => ITool | undefined,
  ): (input: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult> {
    const steps = spec.steps!;

    return async (input, context) => {
      const outputs = new Map<string, string>();
      let lastOutput = "";

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const tool = toolLookup?.(step.tool);
        if (!tool) {
          return {
            content: `Composite step ${i} failed: tool '${step.tool}' not found`,
            isError: true,
          };
        }

        if (COMPOSITE_BLOCKED_TOOLS.has(step.tool)) {
          return {
            content: `Composite step ${i} blocked: tool '${step.tool}' is too dangerous for composite chains.`,
            isError: true,
          };
        }

        // Resolve parameters — substitute {{param}} and {{stepName}} references
        const resolvedParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.params)) {
          resolvedParams[key] = resolveParamValue(value, input, outputs);
        }

        const result = await tool.execute(resolvedParams, context);
        if (result.isError) {
          return {
            content: `Composite step ${i} (${step.tool}) failed: ${result.content}`,
            isError: true,
          };
        }

        lastOutput = result.content;
        if (step.outputAs) {
          outputs.set(step.outputAs, result.content);
        }
      }

      return { content: lastOutput };
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a parameter value template by substituting references.
 *
 * Supports:
 * - `{{paramName}}` — references input parameter
 * - `{{step.outputAs}}` — references output from a previous composite step
 * - literal values pass through unchanged
 */
function resolveParamValue(
  template: string,
  input: Record<string, unknown>,
  stepOutputs: Map<string, string>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_match, ref: string) => {
    // Check step outputs first (dot notation like "step1.field" not supported — full match)
    if (stepOutputs.has(ref)) {
      return stepOutputs.get(ref)!;
    }
    // Then check input params
    const val = input[ref];
    if (val !== undefined && val !== null) {
      return String(val);
    }
    return "";
  });
}
