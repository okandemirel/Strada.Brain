/**
 * Could shell_exec check anything in this project?
 *
 * The repo counts a shell `npm test`, `pytest` or `cargo test` as a
 * verification (isVerificationStep's shell branch), so a run offered
 * shell_exec can verify whenever the project holds something to check. The
 * tool registry alone cannot tell: it holds dedicated check tools for .NET
 * and Unity only, so every Node, Python or Go project read as "nothing can
 * verify" (QA of #41, 2026-11-15).
 *
 * "Nothing to check" is an absence, and every list that measured it fell
 * short: the registry's tool names, then the root's manifests, then the
 * whole tree's manifests of 37 kinds. Each time QA found the next kind that
 * was not on the list, a Django manage.py, a unittest tests.py, a test.sh, a
 * Package.swift, and the exit opened on "the project declares no check" (QA
 * of #41, 2026-11-16). So the row is turned around and rests on what was
 * read: it allows only when every file of the tree is of a closed set of
 * kinds that carry no check, documents and images ({@link INERT_KINDS}).
 * Source code, a script, a manifest, or a file of any kind not on that list
 * keeps the gate, and the record names it (`otherFiles`). `node --check
 * main.js` is a check, so a main.js keeps it too.
 *
 * Inside those kinds, names that a tool reads as input are not inert: pytest
 * collects test*.txt as doctests with no configuration, pip installs from
 * requirements*.txt and constraints*.txt, CMake builds from CMakeLists.txt.
 * A test or spec token in a name keeps the gate as well.
 *
 * The manifest rules stay. They name what a directory declares (`found`:
 * "package.json scripts.test", "app/Makefile test:"), and they keep the gate
 * where a runner collects from a folder of documents (a tests/ directory, a
 * Unity ProjectSettings/).
 *
 * The whole tree is read. The only folders not entered are the version-control
 * stores in {@link SKIPPED_DIRS}, which hold history, not the working tree a
 * check reads, and this assistant's own store at the root ({@link BRAIN_STORE_DIR});
 * the record and the notice name each one met. Dependency and build folders are entered: a generic name like
 * build/ or Library/ hid tools/build/package.json and Library/Library.csproj
 * (QA of #41, 2026-11-16). A scan that reaches a limit ({@link SCAN_LIMITS}),
 * cannot read a directory, or meets a linked directory it does not follow is
 * incomplete, and an incomplete scan says nothing: the gate stays. It stops
 * at the first directory that declares a check, since one keeps the gate.
 */

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";
import { hasDotnetProjectFile } from "../dotnet-project-presence.js";

/** What the project tree holds that shell_exec could check, what was looked for, and how much was read. */
export interface ProjectCheckRecord {
  readonly source: "project tree";
  /**
   * The root read: the orchestrator's project root (InterventionDeps.projectPath;
   * for a delegated run, its workspace lease). When a run's tools write into a
   * lease cut from that root, the lease is a copy; the files the run wrote are
   * judged from the record too (`otherWrites`).
   */
  readonly root: string;
  /** Directories read, the root included. */
  readonly directoriesRead: number;
  /** Files read, by name, in those directories. */
  readonly filesRead: number;
  /** Where the scan stops: entries seen in all, and levels below the root. */
  readonly limits: { readonly entries: number; readonly depth: number };
  /** What is never entered: the version-control stores, and this assistant's own store at the root. */
  readonly skipped: readonly string[];
  /** Those met in this tree, by path. */
  readonly notEntered: readonly string[];
  /** Set when the scan did not cover the tree: what it did not read is unknown, so nothing may be said of it. */
  readonly incomplete?: string;
  /** Every manifest kind looked for in each directory, in order. */
  readonly looked: readonly string[];
  /** Those present that declare a check: "package.json scripts.test", "app/Makefile test:", "server/go.mod". */
  readonly found: readonly string[];
  /** The closed kinds that carry no check: extensions, and whole file names. */
  readonly inertKinds: readonly string[];
  /** Those kinds the files read were of. */
  readonly kindsSeen: readonly string[];
  /** The first files read (up to {@link NAMED_AT_MOST}) of no such kind: each may carry a check. */
  readonly otherFiles: readonly string[];
  /** The paths this run's writers wrote that are of no such kind, from the record (the steps' target paths). */
  readonly otherWrites: readonly string[];
}

/** The scan's limits. A tree that reaches one is not fully read, and the gate stays. */
export const SCAN_LIMITS = { entries: 20_000, depth: 12 } as const;

/** Version-control stores: history, not the working tree. Never entered; met as a file (a worktree's .git), not read either. */
export const SKIPPED_DIRS: readonly string[] = [".git", ".hg", ".svn"];
/**
 * Strada.Brain's own store in a project root (PROJECT_DATA_DIR in
 * core/database-backup.ts): the vault's index, knowledge and databases this
 * assistant writes there, not the project's files. Not entered at the root
 * only: golden run 4's project held .strada/vault/index.db beside README.md.
 */
export const BRAIN_STORE_DIR = ".strada";

/** What the record says is never entered. */
export const NOT_ENTERED: readonly string[] = [...SKIPPED_DIRS, `${BRAIN_STORE_DIR}/ at the root`];

/** Why a folder the scan met was not entered: a version-control store, or this assistant's own store. */
export function notEnteredAs(path: string): "version control" | "brain store" {
  return SKIPPED_DIRS.includes(path.split("/").at(-1) ?? "") ? "version control" : "brain store";
}

/** Extensions of documents and images: nothing builds, runs or tests them. */
const INERT_EXTENSIONS: readonly string[] = [
  ".md", ".markdown", ".txt",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff",
];
/** Whole names that carry no check: licence texts, and version-control and OS bookkeeping. */
const INERT_NAMES: readonly string[] = [
  "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS",
  ".gitignore", ".gitattributes", ".gitkeep", ".keep", ".DS_Store", "Thumbs.db", "desktop.ini",
];
/** The closed set of kinds that carry no check. A file of any other kind keeps the gate. */
export const INERT_KINDS: readonly string[] = [...INERT_EXTENSIONS, ...INERT_NAMES];
/** Names of those kinds that a tool reads as input: pytest's default doctest glob (test*.txt), pip's and CMake's inputs. */
const TOOL_INPUT_RE = /^test|(?:^|[^a-z0-9])(?:tests?|specs?)(?:[^a-z0-9]|$)|requirements|constraints|^cmakelists\.txt$/iu;
/** A folder whose files pip reads: requirements/base.txt. */
const TOOL_INPUT_DIR_RE = /^requirements$/iu;
/** How many files of another kind the record names. One keeps the gate. */
export const NAMED_AT_MOST = 5;

/**
 * The kind a file is of when it carries no check, or null: its extension or
 * its whole name is on the closed list, and neither its name nor a folder on
 * its path is a tool's input. `path` is relative to the root, "/"-separated.
 */
export function inertKind(path: string): string | null {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = segments.at(-1) ?? "";
  if (TOOL_INPUT_RE.test(name) || segments.slice(0, -1).some((dir) => TOOL_INPUT_DIR_RE.test(dir))) return null;
  if (INERT_NAMES.includes(name)) return name;
  const extension = extname(name).toLowerCase();
  return INERT_EXTENSIONS.includes(extension) ? extension : null;
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
 * not cover all of it. `writes` are the paths this run's writers wrote, from
 * the record: each is judged by kind like a file of the tree.
 */
export function measureProjectChecks(
  root: string,
  limits: { readonly entries: number; readonly depth: number } = SCAN_LIMITS,
  readDirectory: ReadDirectory = (dir) => readdirSync(dir, { withFileTypes: true }),
  writes: readonly string[] = [],
): ProjectCheckRecord | null {
  const queue: { readonly dir: string; readonly rel: string; readonly depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
  let entriesSeen = 0;
  let directoriesRead = 0;
  let filesRead = 0;
  const notEntered: string[] = [];
  const kindsSeen = new Set<string>();
  const otherFiles: string[] = [];
  const record = (rest: { readonly found: readonly string[]; readonly incomplete?: string }): ProjectCheckRecord => ({
    source: "project tree", root, directoriesRead, filesRead, limits, skipped: NOT_ENTERED, notEntered: [...notEntered].sort(),
    looked: LOOKED, inertKinds: INERT_KINDS, kindsSeen: [...kindsSeen].sort(), otherFiles,
    otherWrites: [...new Set(writes.filter((path) => inertKind(path) === null))],
    ...rest,
  });
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { dir, rel, depth } = next;
    let entries: Dirent[];
    try {
      entries = readDirectory(dir);
    } catch (err) {
      if (rel === "") return null;
      const code = (err as NodeJS.ErrnoException).code ?? "an error";
      return record({ incomplete: `${rel}/ could not be read (${code})`, found: [] });
    }
    directoriesRead += 1;
    entriesSeen += entries.length;
    if (entriesSeen > limits.entries) return record({ incomplete: `the tree holds more than ${limits.entries} entries`, found: [] });
    const found = directoryChecks(dir, new Set(entries.map((entry) => entry.name)));
    if (found.length > 0) return record({ found: found.map((label) => (rel ? `${rel}/${label}` : label)) });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIPPED_DIRS.includes(entry.name) || (rel === "" && entry.name === BRAIN_STORE_DIR && entry.isDirectory())) {
        notEntered.push(childRel);
        continue;
      }
      if (entry.isSymbolicLink() && isDirectory(path)) {
        return record({ incomplete: `${childRel}/ is a linked directory, not followed`, found: [] });
      }
      if (entry.isDirectory()) {
        if (depth + 1 > limits.depth) return record({ incomplete: `${childRel}/ is deeper than ${limits.depth} levels`, found: [] });
        queue.push({ dir: path, rel: childRel, depth: depth + 1 });
        continue;
      }
      filesRead += 1;
      const kind = inertKind(childRel);
      if (kind !== null) kindsSeen.add(kind);
      else if (otherFiles.length < NAMED_AT_MOST) otherFiles.push(childRel);
    }
  }
  return record({ found: [] });
}
