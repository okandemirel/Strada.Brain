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
  // file_create was missing: work landed exclusively through it produced
  // hasCompilableChanges=false, so the build gate never armed and the run
  // approved with zero build evidence.
  "file_create",
  "shell_exec",
  "strada_create_module", "strada_create_component",
  "strada_create_mediator", "strada_create_system",
]);

/** Tools that verify correctness. */
export const VERIFY_TOOLS: ReadonlySet<string> = new Set([
  "dotnet_build", "dotnet_test",
  "csharp_symbol_search",
  "unity_console_read", "unity_console_analyze",
  "unity_verify_change", "unity_compile_status", "unity_compile_wait",
  "unity_fix_compile_loop", "unity_test_run", "unity_test_results",
  "unity_playmode_test", "unity_editmode_test",
  // Runs the game itself, with no Editor open — the strongest verification
  // available here, and the only one that catches a scene that boots into a
  // module that throws.
  "unity_playmode_verify",
]);

const VERIFY_TOOL_NAME_RE =
  /(?:^|[_-])(build|test|check|verify|lint|typecheck|compile|playmode|editmode|smoke)(?:$|[_-])/iu;

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

export function isVerificationToolName(toolName: string): boolean {
  return VERIFY_TOOLS.has(toolName) || VERIFY_TOOL_NAME_RE.test(toolName);
}

/**
 * Names and shapes that mean a tool changes things.
 *
 * Used for tools registered at runtime, which cannot appear in WRITE_OPERATIONS
 * because they did not exist when it was written. Measured: an agent registered
 * `dynamic_write_minified_file`, a shell-backed file writer, and the policy
 * classified it as a non-write operation — so it ran with no confirmation, would
 * have run in read-only mode, and corrupted five .asmdef files while reporting
 * success.
 *
 * Deliberately broad. An unnecessary confirmation costs a prompt; an unguarded
 * write costs a corrupted project, and in read-only mode it breaks a promise the
 * user was given.
 */
const WRITE_VERB_RE =
  /(^|_)(write|create|add|append|edit|update|modify|patch|delete|remove|rename|move|copy|save|generate|install|apply|format|fix|refactor|migrate|commit|push|exec|run|shell|bash)(_|$)/i;

/** Parameter names that only make sense when something is being written. */
const WRITE_PARAM_NAMES = new Set(["content", "contents", "text", "body", "data", "patch", "diff"]);

/**
 * Best-effort classification for a tool the allowlist does not know.
 *
 * Returns true when the name reads like a mutation, or when the parameters pair
 * a target with a payload — the shape of every file writer.
 */
export function looksLikeWriteTool(toolName: string, tool?: { inputSchema?: unknown }): boolean {
  if (WRITE_VERB_RE.test(toolName)) return true;

  const schema = tool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  const params = Object.keys(schema?.properties ?? {});
  const hasTarget = params.some((p) => /^(path|file|file_path|filePath|filename|target)$/i.test(p));
  const hasPayload = params.some((p) => WRITE_PARAM_NAMES.has(p.toLowerCase()));
  return hasTarget && hasPayload;
}
