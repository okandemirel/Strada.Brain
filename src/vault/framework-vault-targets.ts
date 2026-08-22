import type { StradaDepsStatus } from "../config/strada-deps.js";

export interface FrameworkVaultTarget {
  readonly name: string;
  readonly rootPath: string;
}

/**
 * The codebases this system is supposed to have mastered.
 *
 * Both boot-time vault registrations were pinned to the Unity project, so the
 * only thing ever indexed was the game. Strada.Core, Strada.Modules,
 * Strada.MCP and Brain itself — the systems every plan is written against —
 * were searchable nowhere. Measured 2026-08-22: the game project held 252
 * indexed notes and a 90MB index; the framework repositories held no vault at
 * all, and the knowledge that should have come from reading them arrived
 * instead as prose rules typed into a prompt after each incident.
 *
 * Nothing here reads the disk: callers skip targets they cannot open, so a
 * package that is not installed simply produces no target.
 */
export function frameworkVaultTargets(
  deps: StradaDepsStatus | undefined,
  brainRoot: string | undefined,
): FrameworkVaultTarget[] {
  const candidates: Array<[string, string | null | undefined]> = [
    ["Strada.Brain", brainRoot],
    ["Strada.Core", deps?.coreInstalled ? deps.corePath : null],
    ["Strada.Modules", deps?.modulesInstalled ? deps.modulesPath : null],
    ["Strada.MCP", deps?.mcpInstalled ? deps.mcpPath : null],
  ];

  const seen = new Set<string>();
  const out: FrameworkVaultTarget[] = [];
  for (const [name, path] of candidates) {
    const trimmed = path?.trim();
    if (!trimmed) continue;
    // A submodule copy and its standalone repo can resolve to the same folder;
    // indexing it twice would double the work and split the results.
    const key = trimmed.replace(/\/+$/u, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, rootPath: key });
  }
  return out;
}
