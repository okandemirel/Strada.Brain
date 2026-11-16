/**
 * Does the project declare a check that shell_exec could run?
 *
 * The repo counts a shell `npm test`, `pytest` or `cargo test` as a
 * verification (isVerificationStep's shell branch), so a run offered
 * shell_exec can verify whenever the project declares such a command. The
 * tool registry alone cannot tell: it holds dedicated check tools for .NET
 * and Unity only, so every Node, Python or Go project read as "nothing can
 * verify" (QA of #41, 2026-11-15). This reads the project's own manifests.
 *
 * Only the root is read, as hasDotnetProjectFile does: that is where these
 * files live, and walking the tree on every verdict would cost more than the
 * answer. It errs toward "a check exists": a manifest it cannot read, or
 * whose kind always carries a way to check (Cargo.toml, go.mod, a Python
 * project file), counts as one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hasDotnetProjectFile } from "../dotnet-project-presence.js";

/** What the project root holds that shell_exec could run as a check, and what was looked for. */
export interface ProjectCheckRecord {
  readonly source: "project root manifests";
  /** Every manifest looked for, in order. */
  readonly looked: readonly string[];
  /** Those present that declare a check: "package.json scripts.test", "Makefile test:", "go.mod". */
  readonly found: readonly string[];
}

/** Files whose presence alone means the project has a way to build or test. */
const CHECK_MANIFESTS: readonly string[] = [
  "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "noxfile.py",
  "Cargo.toml", "go.mod",
  "build.gradle", "build.gradle.kts", "pom.xml",
  "CMakeLists.txt", "meson.build",
  "deno.json", "deno.jsonc", "composer.json", "Gemfile", "Rakefile", "mix.exs",
  "justfile", "Justfile", "Taskfile.yml",
  "ProjectSettings/ProjectVersion.txt",
];
const MAKEFILES: readonly string[] = ["Makefile", "makefile", "GNUmakefile"];
const CHECK_NAME_RE = /^(?:test|tests|check|build|lint|typecheck|verify|compile)(?:$|[:_-])/u;
/** `npm init`'s placeholder: a test script that only says there is none. */
const NPM_PLACEHOLDER_RE = /no test specified/u;

/**
 * Present at the root under exactly this name. The root's own listing, not
 * existsSync: on a case-insensitive disk "makefile" exists wherever
 * "Makefile" does, and one file read as two.
 */
type Present = (name: string) => boolean;

function packageJsonChecks(root: string, present: Present): string[] {
  const path = join(root, "package.json");
  if (!present("package.json")) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const scripts = typeof parsed === "object" && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined;
    if (typeof scripts !== "object" || scripts === null) return [];
    return Object.entries(scripts)
      .filter(([name, command]) => CHECK_NAME_RE.test(name) && typeof command === "string" && !NPM_PLACEHOLDER_RE.test(command))
      .map(([name]) => `package.json scripts.${name}`);
  } catch {
    return ["package.json (unreadable)"];
  }
}

function makefileChecks(root: string, present: Present): string[] {
  return MAKEFILES.flatMap((name) => {
    const path = join(root, name);
    if (!present(name)) return [];
    try {
      const targets = [...readFileSync(path, "utf8").matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gmu)].map((m) => m[1]!);
      return targets.filter((t) => CHECK_NAME_RE.test(t)).map((t) => `${name} ${t}:`);
    } catch {
      return [`${name} (unreadable)`];
    }
  });
}

/** Null when the root cannot be read: the ordinary gates apply. */
export function measureProjectChecks(root: string): ProjectCheckRecord | null {
  let entries: ReadonlySet<string>;
  try {
    entries = new Set(readdirSync(root));
  } catch {
    return null;
  }
  const present: Present = (name) => {
    const [first, ...rest] = name.split("/");
    return entries.has(first!) && (rest.length === 0 || existsSync(join(root, name)));
  };
  const looked = [
    "package.json (test/build/check/lint scripts)",
    ...MAKEFILES.map((m) => `${m} (test/build/check targets)`),
    "*.sln / *.csproj",
    ...CHECK_MANIFESTS,
  ];
  const found = [
    ...packageJsonChecks(root, present),
    ...makefileChecks(root, present),
    ...(hasDotnetProjectFile(root) ? ["*.sln / *.csproj"] : []),
    ...CHECK_MANIFESTS.filter(present),
  ];
  return { source: "project root manifests", looked, found };
}
