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
 * "None" may only be said of the whole tree. Reading the root alone missed a
 * check declared one level down (app/package.json, backend/pyproject.toml,
 * src/App/App.csproj, server/go.mod, a workspaces monorepo's packages/a):
 * the exit opened and the user was told the project declares none (QA of
 * #41, 2026-11-16). So every directory is read, except the dependency,
 * build-output and VCS folders named in SKIPPED_DIRS, up to SCAN_LIMITS. A
 * scan that reaches a limit, cannot read a directory, or meets a linked
 * directory it does not follow is incomplete, and an incomplete scan says
 * nothing: the gate stays. It stops at the first directory that declares a
 * check, since one is enough to keep the gate.
 *
 * In each directory it errs toward "a check exists": a manifest it cannot read, or
 * whose kind always carries a way to check (Cargo.toml, go.mod, a Python
 * project file), counts as one. So do the things a check runner finds by
 * itself, with no script naming it (QA of #41, 2026-11-16): a tsconfig.json
 * (`tsc --noEmit`), a conftest.py or a test file at the root (`pytest`,
 * `go test`), a test directory, and a known test or build tool among
 * package.json's dependencies (`npx vitest run`).
 */

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { hasDotnetProjectFile } from "../dotnet-project-presence.js";

/** What the project tree holds that shell_exec could run as a check, what was looked for, and how much was read. */
export interface ProjectCheckRecord {
  readonly source: "project tree manifests";
  /**
   * The root read: the orchestrator's project root (InterventionDeps.projectPath;
   * for a delegated run, its workspace lease). When a run's tools write into a
   * lease cut from that root, the lease is a copy: the two differ only in a
   * manifest the run itself changed there.
   */
  readonly root: string;
  /** Directories read, the root included. */
  readonly directoriesRead: number;
  /** Where the scan stops: entries seen in all, and levels below the root. */
  readonly limits: { readonly entries: number; readonly depth: number };
  /** Directory names never entered. */
  readonly skipped: readonly string[];
  /** Set when the scan did not cover the tree: what it did not read is unknown, so nothing may be said of it. */
  readonly incomplete?: string;
  /** Every manifest kind looked for in each directory, in order. */
  readonly looked: readonly string[];
  /** Those present that declare a check: "package.json scripts.test", "app/Makefile test:", "server/go.mod". */
  readonly found: readonly string[];
}

/** The scan's limits. A tree that reaches one is not fully read, and the gate stays. */
export const SCAN_LIMITS = { entries: 20_000, depth: 12 } as const;

/** Dependency, build-output, VCS and tool-cache folders: what they hold is not the project's own check. */
export const SKIPPED_DIRS: readonly string[] = [
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor", ".venv", "venv", "__pycache__",
  "dist", "build", "out", "target", "bin", "obj", "coverage", ".next", ".nuxt", ".cache", ".gradle",
  "Library", "Temp", "Logs", "Pods", "DerivedData",
];

/** Files whose presence alone means the project has a way to build or test. */
const CHECK_MANIFESTS: readonly string[] = [
  "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "noxfile.py",
  "Cargo.toml", "go.mod",
  "build.gradle", "build.gradle.kts", "pom.xml",
  "CMakeLists.txt", "meson.build",
  "deno.json", "deno.jsonc", "composer.json", "Gemfile", "Rakefile", "mix.exs",
  "justfile", "Justfile", "Taskfile.yml",
  "ProjectSettings/ProjectVersion.txt",
  "tsconfig.json", "jsconfig.json", "conftest.py",
];
/** Directories a test runner collects from by default. */
const TEST_DIRS: readonly string[] = ["test", "tests", "__tests__", "spec"];
/** Root files a runner collects with no configuration: test_x.py, x_test.py, x_test.go, x.test.ts, x.spec.js. */
const TEST_FILE_RE = /^(?:test_[\w-]+\.py|[\w-]+_test\.(?:py|go)|[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)$/u;
/** Packages that run a check when installed: `npx <it>` tests, typechecks, lints or builds. */
const CHECK_PACKAGES: ReadonlySet<string> = new Set([
  "typescript", "vitest", "jest", "mocha", "ava", "tap", "jasmine", "karma", "uvu",
  "@playwright/test", "playwright", "cypress", "eslint", "@biomejs/biome",
  "vite", "webpack", "esbuild", "rollup", "parcel", "tsup",
]);
const MAKEFILES: readonly string[] = ["Makefile", "makefile", "GNUmakefile"];
const CHECK_NAME_RE = /^(?:test|tests|check|build|lint|typecheck|verify|compile)(?:$|[:_-])/u;
/** `npm init`'s placeholder: a test script that only says there is none. */
const NPM_PLACEHOLDER_RE = /no test specified/u;

/**
 * Present in the directory under exactly this name. The directory's own
 * listing, not existsSync: on a case-insensitive disk "makefile" exists
 * wherever "Makefile" does, and one file read as two.
 */
type Present = (name: string) => boolean;

function packageJsonChecks(root: string, present: Present): string[] {
  const path = join(root, "package.json");
  if (!present("package.json")) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const scripts = record["scripts"];
    const scriptChecks = typeof scripts === "object" && scripts !== null
      ? Object.entries(scripts)
        .filter(([name, command]) => CHECK_NAME_RE.test(name) && typeof command === "string" && !NPM_PLACEHOLDER_RE.test(command))
        .map(([name]) => `package.json scripts.${name}`)
      : [];
    const packageChecks = ["dependencies", "devDependencies"].flatMap((field) => {
      const deps = record[field];
      return typeof deps === "object" && deps !== null
        ? Object.keys(deps).filter((name) => CHECK_PACKAGES.has(name)).map((name) => `package.json ${field}.${name}`)
        : [];
    });
    return [...scriptChecks, ...packageChecks];
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const LOOKED: readonly string[] = [
  "package.json (test/build/check/lint scripts)",
  ...MAKEFILES.map((m) => `${m} (test/build/check targets)`),
  "*.sln / *.csproj",
  ...CHECK_MANIFESTS,
  `package.json dependencies (${[...CHECK_PACKAGES].join(", ")})`,
  ...TEST_DIRS.map((d) => `${d}/`),
  "test files (test_*.py, *_test.py, *_test.go, *.test.*, *.spec.*)",
];

/** What one directory declares, by the rules above. */
function directoryChecks(dir: string, names: ReadonlySet<string>): string[] {
  const present: Present = (name) => {
    const [first, ...rest] = name.split("/");
    return names.has(first!) && (rest.length === 0 || existsSync(join(dir, name)));
  };
  return [
    ...packageJsonChecks(dir, present),
    ...makefileChecks(dir, present),
    ...(hasDotnetProjectFile(dir) ? ["*.sln / *.csproj"] : []),
    ...CHECK_MANIFESTS.filter(present),
    ...TEST_DIRS.filter((d) => names.has(d) && isDirectory(join(dir, d))).map((d) => `${d}/`),
    ...[...names].filter((name) => TEST_FILE_RE.test(name)).sort(),
  ];
}

/** How the scan reads a directory; a test may stand in for the disk. */
export type ReadDirectory = (dir: string) => Dirent[];

/**
 * Null when the root cannot be read: the ordinary gates apply. Otherwise the
 * record of a breadth-first scan of the tree; `incomplete` says why it did
 * not cover all of it.
 */
export function measureProjectChecks(
  root: string,
  limits: { readonly entries: number; readonly depth: number } = SCAN_LIMITS,
  readDirectory: ReadDirectory = (dir) => readdirSync(dir, { withFileTypes: true }),
): ProjectCheckRecord | null {
  const base = { source: "project tree manifests" as const, root, limits, skipped: SKIPPED_DIRS, looked: LOOKED };
  const queue: { readonly dir: string; readonly rel: string; readonly depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
  let entriesSeen = 0;
  let directoriesRead = 0;
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { dir, rel, depth } = next;
    let entries: Dirent[];
    try {
      entries = readDirectory(dir);
    } catch (err) {
      if (rel === "") return null;
      const code = (err as NodeJS.ErrnoException).code ?? "an error";
      return { ...base, directoriesRead, incomplete: `${rel}/ could not be read (${code})`, found: [] };
    }
    directoriesRead += 1;
    entriesSeen += entries.length;
    if (entriesSeen > limits.entries) {
      return { ...base, directoriesRead, incomplete: `the tree holds more than ${limits.entries} entries`, found: [] };
    }
    const found = directoryChecks(dir, new Set(entries.map((entry) => entry.name)));
    if (found.length > 0) return { ...base, directoriesRead, found: found.map((label) => (rel ? `${rel}/${label}` : label)) };
    for (const entry of entries) {
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() && isDirectory(path)) {
        return { ...base, directoriesRead, incomplete: `${childRel}/ is a linked directory, not followed`, found: [] };
      }
      if (!entry.isDirectory()) continue;
      if (depth + 1 > limits.depth) {
        return { ...base, directoriesRead, incomplete: `${childRel}/ is deeper than ${limits.depth} levels`, found: [] };
      }
      queue.push({ dir: path, rel: childRel, depth: depth + 1 });
    }
  }
  return { ...base, directoriesRead, found: [] };
}
