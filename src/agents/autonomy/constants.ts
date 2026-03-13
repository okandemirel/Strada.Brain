/**
 * Shared constants for the autonomy layer.
 *
 * Single source of truth for tool classification and input extraction.
 * All lookups are O(1) via ReadonlySet.has().
 * 
 * NOTE: WRITE_OPERATIONS is now defined in common/constants.ts
 * and re-exported here for backward compatibility.
 */

// Re-export from common/constants for backward compatibility
export { WRITE_OPERATIONS } from "../../common/constants.js";

/** Tools that mutate source files (subset of WRITE_OPERATIONS). */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "file_write", "file_edit", "file_delete", "file_rename",
  "strada_create_module", "strada_create_component",
  "strada_create_mediator", "strada_create_system",
]);

/** Tools that verify correctness. */
export const VERIFY_TOOLS: ReadonlySet<string> = new Set([
  "dotnet_build", "dotnet_test",
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
