/**
 * Shared constants for the autonomy layer.
 *
 * Single source of truth for tool classification and input extraction.
 * All lookups are O(1) via ReadonlySet.has().
 */

/** Tools that mutate source files (subset of WRITE_OPERATIONS). */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "file_write", "file_edit", "file_delete", "file_rename",
  "strata_create_module", "strata_create_component",
  "strata_create_mediator", "strata_create_system",
]);

/** Tools that verify correctness. */
export const VERIFY_TOOLS: ReadonlySet<string> = new Set([
  "dotnet_build", "dotnet_test",
]);

/** Tools with side effects beyond file mutation (not in MUTATION_TOOLS or VERIFY_TOOLS). */
const SIDE_EFFECT_TOOLS: readonly string[] = [
  "file_delete_directory",
  "shell_exec",
  "git_commit", "git_push", "git_branch", "git_stash",
];

/** All tools that require user confirmation. Composed from subsets to prevent drift. */
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  ...MUTATION_TOOLS,
  ...VERIFY_TOOLS,
  ...SIDE_EFFECT_TOOLS,
]);

/** File extensions that affect .NET compilation. */
export const COMPILABLE_EXT: ReadonlySet<string> = new Set([
  ".cs", ".csproj", ".sln", ".props", ".targets",
]);

/**
 * Extract the file path from a tool's input object.
 * Handles the different key names used by various tools.
 */
export function extractFilePath(input: Record<string, unknown>): string {
  return String(input["path"] ?? input["file"] ?? input["name"] ?? "");
}
