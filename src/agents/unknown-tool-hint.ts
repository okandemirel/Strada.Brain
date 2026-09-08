/**
 * What to say when the model calls a tool that does not exist.
 *
 * Measured 2026-09-08 07:2x: "Error: unknown tool 'bash'" twice in one
 * sprint — the model reached for a shell by the name it knows from other
 * harnesses while shell_exec sat in its tool list. A bare "unknown" costs a
 * turn per guess; naming the neighbour costs nothing.
 */

const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(bash|sh|zsh|shell|run_command|run_shell|execute_command|terminal|exec)$/i, "shell_exec"],
  [/^(read_file|cat|view_file|open_file|read)$/i, "file_read"],
  [/^(write_file|create_file|save_file|write)$/i, "file_write"],
  [/^(edit_file|str_replace|replace_in_file|patch|edit)$/i, "file_edit"],
  [/^(delete_file|remove_file|rm|unlink)$/i, "file_delete"],
  [/^(ls|list_files|list_dir|dir|readdir)$/i, "list_directory"],
  [/^(grep|rg|ripgrep|search_text|search)$/i, "grep_search"],
  [/^(find|glob|find_files|list_glob)$/i, "glob_search"],
  [/^(git)$/i, "git_status"],
];

/** The most plausible registered tool for `name`, or undefined when nothing is close. */
export function suggestTool(name: string, registered: Iterable<string>): string | undefined {
  const names = [...registered];
  const has = (n: string): boolean => names.includes(n);
  for (const [re, target] of ALIASES) {
    if (re.test(name) && has(target)) return target;
  }
  const lower = name.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  let best: { name: string; score: number } | undefined;
  for (const candidate of names) {
    const c = candidate.toLowerCase();
    let score = 0;
    if (c.includes(lower) || lower.includes(c)) score += 3;
    for (const t of tokens) if (c.includes(t)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { name: candidate, score };
  }
  return best?.name;
}

export function unknownToolMessage(name: string, registered: Iterable<string>): string {
  const suggestion = suggestTool(name, registered);
  return (
    `Error: unknown tool '${name}'` +
    (suggestion ? ` — did you mean ${suggestion}?` : "") +
    " Only the tools in this request's tool list exist; call one of those by its exact name."
  );
}
