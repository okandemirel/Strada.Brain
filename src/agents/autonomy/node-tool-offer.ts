/**
 * Which tools a plan node's worker is offered.
 *
 * Every worker turn used to carry the whole registry: measured 2026-09-10
 * 14:34, 106 tools, 73 352 characters of schema on a 36–51 k-token prompt —
 * half of every turn spent describing tools the node would never call — and
 * a node whose task is "call unity_delivery_measure, then unity_generate_sprite
 * twice" is offered animation, navmesh and asset-store tools it cannot use.
 *
 * A node's task names what it needs. The offer is the core set every node
 * may need (read, write, search, git, verify, measure), plus every tool the
 * node text names, plus that tool's family (same `a_b_` prefix: naming
 * unity_generate_sprite brings unity_generate_mesh and unity_generate_audio).
 * Withholding is only about what the model SEES: execution resolves from the
 * full registry, so a tool the model names anyway still runs.
 *
 * A node that names no tool at all cannot be narrowed by its text and keeps
 * the whole offer — narrowing on a guess would hide the tool it needed.
 */
export const NODE_SCOPE_MARKER = "## Scope of this node";

/** Tools every node may need regardless of what its task names. */
export const NODE_CORE_TOOLS: ReadonlySet<string> = new Set([
  "file_read", "file_write", "file_edit", "file_delete", "file_rename", "list_directory",
  "glob_search", "grep_search", "code_search_rag", "vault_search",
  "csharp_symbol_search", "csharp_symbol_references", "csharp_parse",
  "shell_exec", "batch_execute",
  "git_status", "git_diff", "git_log", "git_commit",
  "unity_verify_change", "unity_compile_status", "unity_console_analyze",
  "unity_delivery_measure", "unity_playmode_verify", "unity_playthrough",
  "unity_scene_analyze", "unity_prefab_analyze",
  "project_health",
]);

export interface NodeToolOffer<T> {
  readonly offered: T[];
  /** Names the node text mentions verbatim, in order of appearance. */
  readonly named: string[];
  readonly withheld: number;
  /** False when the text named no tool and the whole offer was kept. */
  readonly narrowed: boolean;
}

export function isNodeScopedTask(taskText: string): boolean {
  return taskText.includes(NODE_SCOPE_MARKER);
}

/** `unity_generate_sprite` → `unity_generate_`; a one-segment name has no family. */
function familyOf(name: string): string | null {
  const parts = name.split("_");
  return parts.length >= 3 ? `${parts[0]}_${parts[1]}_` : null;
}

export function selectNodeTools<T extends { readonly name: string }>(
  nodeText: string,
  tools: readonly T[],
): NodeToolOffer<T> {
  const named: string[] = [];
  for (const tool of tools) {
    const at = nodeText.indexOf(tool.name);
    if (at < 0) continue;
    const before = at === 0 ? " " : nodeText[at - 1]!;
    const after = nodeText[at + tool.name.length] ?? " ";
    // A whole identifier, not a prefix of a longer one (unity_playmode_verify
    // inside unity_playmode_verify_x) — and not a piece of a path.
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    named.push(tool.name);
  }
  named.sort((a, b) => nodeText.indexOf(a) - nodeText.indexOf(b));
  if (named.length === 0) {
    return { offered: [...tools], named, withheld: 0, narrowed: false };
  }
  const families = new Set(named.map(familyOf).filter((f): f is string => f !== null));
  const keep = new Set<string>(named);
  for (const tool of tools) {
    if (NODE_CORE_TOOLS.has(tool.name)) keep.add(tool.name);
    const family = familyOf(tool.name);
    if (family !== null && families.has(family)) keep.add(tool.name);
  }
  const offered = tools.filter((t) => keep.has(t.name));
  return { offered, named, withheld: tools.length - offered.length, narrowed: true };
}
