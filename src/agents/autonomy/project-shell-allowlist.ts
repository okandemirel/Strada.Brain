/**
 * Deterministic project-scoped shell allowlist — consulted BEFORE the LLM shell
 * reviewer.
 *
 * Measured 2026-08-23 (PixelFlow run): the conformance gate demanded
 * "GAME NEVER RUN — run the game", the agent answered with exactly the right
 * command (Unity -batchmode -runTests against its own project), and the LLM
 * shell reviewer rejected it twice — once "inconclusive", once "looks
 * destructive". Gate and gatekeeper deadlocked: the one command that satisfies
 * delivery verification was unrunnable, so no autonomous run could ever pass.
 *
 * These patterns are bounded by construction: they target the CURRENT project,
 * they build/test/run rather than delete, and their flags are whitelisted.
 * Anything not matched here falls through to the LLM reviewer unchanged.
 */

export interface ProjectShellAllowlistMatch {
  /** Human-readable rule that approved the command. */
  readonly rule: string;
}

interface AllowlistRule {
  name: string;
  matches(command: string, projectRoot: string): boolean;
}

/** True when an absolute path mentioned in the command stays inside root (or is relative/tokensafe). */
function pathsStayInRoot(command: string, projectRoot: string): boolean {
  // Absolute paths that point somewhere else than the project are how /tmp
  // side-projects happened. Relative paths and bare flags are fine.
  const absolutePaths = command.match(/(?:^|[\s="'])\/(?!Applications\/Unity\/)[^\s"']+/g) ?? [];
  for (const raw of absolutePaths) {
    const p = raw.replace(/^[\s="']+/, "");
    if (p.startsWith(projectRoot)) continue;
    // System read-only lookups are harmless in build commands.
    if (/^\/(usr|bin|sbin|etc|var|private\/var\/folders)\//.test(p) && !/rm\s|mv\s/.test(command)) continue;
    if (/^\/tmp\//.test(p)) return false;
    return false;
  }
  return true;
}

const RULES: readonly AllowlistRule[] = [
  {
    name: "unity-batchmode (build/test/run the current project headlessly)",
    matches(command, projectRoot) {
      // Audited 2026-09-02: this rule tested four unanchored substrings and
      // returned true, so it pre-approved the WHOLE line — a chained command, a
      // prefix ahead of the Unity token, or a -logFile outside the project rode
      // along on the match, which then suppressed isDestructiveOperation and
      // overrode a reviewer rejection. It approves ONE Unity invocation, at the
      // start of the line, whose every path stays inside the project.
      if (!/^\s*"?\/Applications\/Unity\/[^"\s]*\/Unity\.app\/Contents\/MacOS\/Unity(\s|"|$)/.test(command)) return false;
      if (/;|&&|\|\||\||`|\n|\$\(|&\s*$/.test(command)) return false;
      if (/(^|[\s="'])~|\.\.\//.test(command)) return false;
      if (!/-batchmode\b/.test(command)) return false;
      // One of the three bounded purposes: open-and-quit, run tests, run a method.
      if (!/(-quit\b|-runTests\b|-executeMethod\b)/.test(command)) return false;
      // The project it touches must be THIS project.
      const projectArg = /-projectPath\s+"?\$?{?PWD}??"?(?:\s|$)/.exec(command)
        ?? new RegExp(`-projectPath\\s+"?${projectRoot.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"?(?:\\s|$)`).exec(command);
      if (!projectArg) return false;
      return pathsStayInRoot(command, projectRoot);
    },
  },
  {
    name: "dotnet build/test inside the project",
    matches(command, projectRoot) {
      if (!/(^|[;&|(]\s*)dotnet\s+(build|test|vstest)\b/.test(command)) return false;
      if (/dotnet\s+(publish|nuget\s+push)/.test(command)) return false;
      return pathsStayInRoot(command, projectRoot);
    },
  },
  {
    name: "read-only file inspection (hash/stat/file/wc)",
    matches(command, projectRoot) {
      if (!/(^|[;&|(]\s*)(md5|md5sum|shasum|sha256sum|sha1sum|file|stat|wc)\s/.test(command)) return false;
      // Hashing/inspecting outside the project could probe secrets — stay in.
      return pathsStayInRoot(command, projectRoot);
    },
  },
  {
    name: "git inspection + in-project integration (merge/checkout, no force, no push)",
    matches(command, projectRoot) {
      if (!/(^|[;&|(]\s*)git\s+/.test(command)) return false;
      // History-rewriting and remote operations are refused wherever they
      // appear in the chain — including mid-command flag forms like
      // `git branch -f main <sha>` (measured in review 2026-08-24).
      const destructiveGit =
        /\b(push|pull\b|fetch\b|remote\b|clean\b|rebase\b)\b/.test(command)
        || /--force\b/.test(command)
        || /git\s+[^|;&]*\s-f\s/.test(command)
        || /reset\s+--hard/.test(command);
      if (destructiveGit) return false;
      return pathsStayInRoot(command, projectRoot);
    },
  },
];

/**
 * Return the matching rule when the command is pre-approved without an LLM
 * review; null when it must go to the reviewer as before.
 */
const DESTRUCTIVE_RE =
  /\b(rm\s+[^|;&]*-[a-zA-Z]*[rf]|mkfs\b|dd\s+if=|:\\(\\)(\\)(\\):|shutdown\b|reboot\b|halt\b|poweroff\b|>\s*\/dev\/)/;

export function matchProjectScopedAllowlist(
  command: string,
  projectRoot: string | undefined,
): ProjectShellAllowlistMatch | null {
  if (!projectRoot || !command.trim()) return null;
  // A benign suffix must not launder a destructive prefix ("rm -rf / && git status").
  if (DESTRUCTIVE_RE.test(command)) return null;
  for (const rule of RULES) {
    try {
      if (rule.matches(command, projectRoot)) {
        return { rule: rule.name };
      }
    } catch {
      // A malformed rule must never block the review pipeline.
    }
  }
  return null;
}
