/**
 * Read-Only Guard - Prevents write operations when in read-only mode
 */

import type { ITool } from "../agents/tools/tool.interface.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const READ_ONLY_TIMEOUT_MS = 120_000; // 2 minutes

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  // File operations
  "file_write",
  "file_edit",
  "file_delete",
  "file_rename",
  "file_delete_directory",
  // Git operations
  "git_commit",
  "git_push",
  "git_branch",
  "git_stash",
  "git_reset",
  "git_checkout",
  "git_merge",
  "git_rebase",
  // Shell & Code generation
  "shell_exec",
  "strada_create_module",
  "strada_create_component",
  "strada_create_mediator",
  "strada_create_system",
  // .NET operations
  "dotnet_add_package",
  "dotnet_remove_package",
  "dotnet_new",
  // NOTE: create_tool and remove_dynamic_tool are runtime-only and reversible.
  // They use internal guards instead. create_skill writes to disk but also
  // uses its own read-only check for a better error message.
]);

const READ_TOOLS: ReadonlySet<string> = new Set([
  "file_read",
  "file_search",
  "file_list",
  "file_exists",
  "file_grep",
  "code_search",
  "code_find_references",
  "code_find_usages",
  "git_status",
  "git_log",
  "git_diff",
  "git_show",
  "dotnet_build",
  "dotnet_test",
  "dotnet_list_packages",
  "analyze_project",
  "analyze_code_quality",
  "strada_analyze_project",
  "memory_search",
  "memory_recall",
  "rag_search",
]);

const SUGGESTIONS: Record<string, string> = {
  file_write: "Use 'file_read' to examine existing files instead.",
  file_edit: "Use 'file_read' to view file contents instead.",
  file_delete: "File deletion is not available in read-only mode.",
  file_rename: "Use 'file_read' or 'code_search' to explore the codebase.",
  file_delete_directory: "Directory deletion is not available in read-only mode.",
  git_commit: "Use 'git_status' or 'git_diff' to review changes instead.",
  git_push: "Use 'git_log' to view commit history instead.",
  git_branch: "Use 'git_status' to see current branch information.",
  git_stash: "Stashing is not available in read-only mode.",
  shell_exec: "Shell commands are disabled in read-only mode. Use built-in read tools instead.",
  strada_create_module:
    "Code generation is disabled in read-only mode. Use analysis tools to explore existing modules.",
  strada_create_component:
    "Code generation is disabled in read-only mode. Use analysis tools to explore existing components.",
  strada_create_mediator:
    "Code generation is disabled in read-only mode. Use analysis tools to explore existing mediators.",
  strada_create_system:
    "Code generation is disabled in read-only mode. Use analysis tools to explore existing systems.",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReadOnlyCheckResult {
  allowed: boolean;
  error?: string;
  suggestion?: string;
}

// ─── Core Functions ──────────────────────────────────────────────────────────

export function checkReadOnlyBlock(toolName: string, readOnlyMode: boolean): ReadOnlyCheckResult {
  if (!readOnlyMode) {
    return { allowed: true };
  }

  const normalizedName = toolName.toLowerCase().trim();

  if (WRITE_TOOLS.has(normalizedName)) {
    return {
      allowed: false,
      error: `Tool '${toolName}' is disabled in read-only mode.`,
      suggestion: SUGGESTIONS[normalizedName] ?? "Use read-only tools to explore the codebase.",
    };
  }

  // Dynamic tools (dynamic_*) are NOT blanket-blocked here.
  // Shell-strategy dynamic tools check context.readOnly in their executor.
  // Composite-strategy dynamic tools are safe (they only chain existing tools).
  // This allows composite dynamic tools to work in read-only mode.

  return { allowed: true };
}

export function createReadOnlyToolStub(toolName: string, toolCallId: string) {
  const check = checkReadOnlyBlock(toolName, true);

  return {
    toolCallId,
    content: [
      `❌ ${check.error}`,
      "",
      `💡 ${check.suggestion}`,
      "",
      "To enable write operations, set READ_ONLY_MODE=false in your environment.",
    ].join("\n"),
    isError: true,
  };
}

export function getReadOnlySystemPrompt(): string {
  return `
## ⚠️ READ-ONLY MODE ACTIVE

You are currently operating in **read-only mode**. The following operations are **disabled**:

### Blocked Operations
- Creating, editing, or deleting files
- Executing shell commands
- Making git commits or pushing changes
- Generating new code (modules, components, systems)

### Available Operations
- Reading files and searching code
- Analyzing project structure
- Running builds and tests (read-only verification)
- Searching memory and documentation

### How to Help in Read-Only Mode
1. **Analyze** the existing codebase thoroughly
2. **Search** for relevant code patterns and examples
3. **Explain** how the code works
4. **Suggest** improvements (but note they cannot be applied)
5. **Document** findings for later implementation

When the user asks for changes, explain what you would do if write mode were enabled, but clarify that you cannot make those changes in the current read-only configuration.
`;
}

export function getReadOnlyToolSummary() {
  return {
    blocked: Array.from(WRITE_TOOLS).sort(),
    allowed: Array.from(READ_TOOLS).sort(),
    totalBlocked: WRITE_TOOLS.size,
    totalAllowed: READ_TOOLS.size,
  };
}

export function filterToolsForReadOnly<T extends { name: string }>(
  tools: T[],
  readOnlyMode: boolean,
): T[] {
  return readOnlyMode ? tools.filter((t) => !WRITE_TOOLS.has(t.name)) : tools;
}

export function wrapToolForReadOnly(tool: ITool, readOnlyMode: boolean): ITool {
  if (!readOnlyMode) return tool;

  const check = checkReadOnlyBlock(tool.name, true);

  if (check.allowed) return tool;

  return {
    name: tool.name,
    description: `[READ-ONLY] ${tool.description} (This tool is currently disabled)`,
    inputSchema: tool.inputSchema,
    execute: async () => ({
      content: `${check.error}\n\n${check.suggestion}`,
      isError: true,
    }),
  };
}

// ─── ReadOnlyGuard Class ─────────────────────────────────────────────────────

export class ReadOnlyGuard {
  private readonly enabled: boolean;
  private readonly blockedTools: Set<string>;

  constructor(enabled: boolean, additionalBlockedTools: string[] = []) {
    this.enabled = enabled;
    this.blockedTools = new Set([...Array.from(WRITE_TOOLS), ...additionalBlockedTools]);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  canExecute(toolName: string): boolean {
    return !this.enabled || !this.blockedTools.has(toolName.toLowerCase().trim());
  }

  check(toolName: string): ReadOnlyCheckResult {
    return checkReadOnlyBlock(toolName, this.enabled);
  }

  getSystemPrompt(): string {
    return this.enabled ? getReadOnlySystemPrompt() : "";
  }

  createStub(toolName: string, toolCallId: string) {
    return createReadOnlyToolStub(toolName, toolCallId);
  }

  filterTools<T extends { name: string }>(tools: T[]): T[] {
    return filterToolsForReadOnly(tools, this.enabled);
  }

  /**
   * Assert that the system is not in read-only mode.
   * Throws if read-only mode is active.
   */
  assertWritable(operation: string): void {
    if (this.enabled) {
      throw new Error(`Operation '${operation}' blocked: system is in read-only mode`);
    }
  }
}

// ─── Pending Confirmation Types (for external use) ────────────────────────────

export interface PendingConfirmation {
  id: string;
  toolCallId: string;
  toolName: string;
  resolve: (value: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export { READ_ONLY_TIMEOUT_MS, WRITE_TOOLS, READ_TOOLS };
