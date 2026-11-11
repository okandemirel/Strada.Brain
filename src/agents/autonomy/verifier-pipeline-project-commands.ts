/**
 * Does the project declare a build or test command a shell could run?
 *
 * The unverifiable-failure exit (verifier-pipeline-unverifiable.ts) closes a
 * re-run failure on an honest "not verified" when no tool offered to the turn
 * runs a check. `shell_exec` is not such a tool, yet a shell runs `npm test`,
 * `pytest` or `cargo test`, and the completion review counts that run as a
 * verification (isVerificationStep). So in a run that offers the shell, the
 * exit holds only when the project itself declares no command to run, and
 * that is read here, from its manifests, never from the draft.
 *
 * Verdicts:
 * - "commands": a recognised manifest declares one (MANIFEST_COMMANDS below, a
 *   package.json build/test script, a Python test configuration or test file,
 *   a .sln/.csproj, a Unity project, or a build system whose files carry their
 *   own commands: Cargo.toml, go.mod, a Makefile...). The gate stays.
 * - "none": the root was read, no manifest declares a command, and every
 *   source file found belongs to a language whose manifest was read and
 *   declared nothing (package.json for JS/TS, pyproject.toml and its kin for
 *   Python), or there is no source file at all. The exit applies.
 * - "unknown": anything else: an unreadable root or manifest, source code of a
 *   language with no manifest here, or a tree too large to walk. An unknown
 *   project type may have a command, so the gate stays.
 *
 * npm's placeholder test script (`echo "Error: no test specified" && exit 1`)
 * is not a test: `npm init` writes it into every package.json.
 *
 * The root read is the project's source root (sourceProjectPath), never a
 * workspace lease: a lease is a per-worker copy, and the project's
 * verification path is what the project declares.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { hasDotnetProjectFile } from "../dotnet-project-presence.js";

export type ProjectCommandsVerdict = "commands" | "none" | "unknown";

export interface ProjectCommandsRecord {
  readonly verdict: ProjectCommandsVerdict;
  /** The directory read. */
  readonly root: string;
  readonly rootSource: "the project's source root, not a workspace lease";
  /** Each manifest found at the root and what it declares, e.g. "package.json: scripts.test". */
  readonly manifests: readonly string[];
  /** Why the verdict is "unknown". */
  readonly reason?: string;
}

/** Build systems whose presence is a command: their files carry their own build and test. */
const BUILD_SYSTEM_FILES: ReadonlySet<string> = new Set([
  "Makefile", "makefile", "GNUmakefile",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "CMakeLists.txt", "meson.build", "Package.swift", "mix.exs", "build.sbt",
  "Rakefile", "deno.json", "deno.jsonc", "justfile", "Justfile", "Taskfile.yml",
  "WORKSPACE", "MODULE.bazel", "BUILD.bazel", "tsconfig.json",
  "pytest.ini", "tox.ini", "conftest.py", "noxfile.py",
]);

/** Python manifests: read for test configuration; with none of them, Python code is an unknown project type. */
const PYTHON_MANIFESTS = ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt", "Pipfile"] as const;

/** Every manifest this module recognises, for the record and its tests. */
export const RECOGNISED_MANIFESTS: readonly string[] = [
  "package.json", ...PYTHON_MANIFESTS, "*.sln", "*.csproj", "ProjectSettings/ProjectVersion.txt", ...BUILD_SYSTEM_FILES,
];

/** package.json scripts that build or test. */
const BUILD_OR_TEST_SCRIPT_RE = /^(?:test|build|check|typecheck|compile|verify)(?::|$)/u;
/** What `npm init` writes as the test script. */
const NPM_PLACEHOLDER_TEST_RE = /^\s*echo\s+["']?Error: no test specified["']?\s*&&\s*exit\s+1\s*$/u;

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]);
const PY_EXT = new Set([".py"]);
/** Source code of languages with no manifest read here: their presence makes the project type unknown. */
const OTHER_CODE_EXT = new Set([
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".java", ".kt", ".kts", ".scala", ".swift", ".m", ".mm",
  ".rs", ".go", ".rb", ".php", ".ex", ".exs", ".erl", ".hs", ".dart", ".lua", ".zig", ".nim", ".fs", ".jl",
  ".r", ".pl", ".sh", ".ps1", ".gd", ".groovy", ".clj", ".ml", ".vb",
]);
const PY_TEST_FILE_RE = /^(?:test_.+|.+_test)\.py$/u;

/**
 * Not walked: installed dependencies, generated caches and dot-directories.
 * Folders that may hold the project's own scripts (bin, build, dist) are walked.
 */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "venv", "Library", "Temp", "Logs", "obj", "target", "coverage"]);
/** A tree larger than this is not walked to the end, and its verdict is "unknown". */
const MAX_ENTRIES = 5_000;

export function measureProjectCommands(root: string | undefined): ProjectCommandsRecord {
  const base = { root: root ?? "", rootSource: "the project's source root, not a workspace lease" } as const;
  const unknown = (reason: string, manifests: readonly string[] = []): ProjectCommandsRecord =>
    ({ ...base, verdict: "unknown", manifests, reason });
  if (!root) return unknown("no project root was given");

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return unknown("the project root could not be read");
  }
  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const commands: string[] = [];
  const declaresNothing: string[] = [];

  if (files.has("package.json")) {
    const scripts = packageScripts(join(root, "package.json"));
    if (scripts === null) return unknown("package.json could not be parsed", ["package.json: unreadable"]);
    const declared = Object.entries(scripts)
      .filter(([name, body]) => BUILD_OR_TEST_SCRIPT_RE.test(name) && typeof body === "string" && body.trim() !== "")
      .filter(([name, body]) => !(name === "test" && NPM_PLACEHOLDER_TEST_RE.test(body as string)))
      .map(([name]) => `package.json: scripts.${name}`);
    if (declared.length > 0) commands.push(...declared);
    else {
      declaresNothing.push(
        typeof scripts["test"] === "string" && NPM_PLACEHOLDER_TEST_RE.test(scripts["test"])
          ? "package.json: no build or test script (scripts.test is npm's placeholder)"
          : "package.json: no build or test script",
      );
    }
  }
  for (const name of PYTHON_MANIFESTS) {
    if (!files.has(name)) continue;
    const text = readText(join(root, name));
    if (text === null) return unknown(`${name} could not be read`, [`${name}: unreadable`]);
    if (name === "pyproject.toml" && /^\[tool\.(?:pytest|tox|nox)\b/mu.test(text)) commands.push(`${name}: pytest/tox configuration`);
    else if (name === "setup.cfg" && /^\[tool:pytest\]/mu.test(text)) commands.push(`${name}: [tool:pytest]`);
    else declaresNothing.push(`${name}: no test configuration`);
  }
  for (const name of [...files].sort()) {
    if (BUILD_SYSTEM_FILES.has(name)) commands.push(`${name}: build system`);
  }
  if (hasDotnetProjectFile(root)) commands.push("*.sln/*.csproj: dotnet build");
  if (existsSync(join(root, "ProjectSettings", "ProjectVersion.txt"))) {
    commands.push("ProjectSettings/ProjectVersion.txt: Unity project");
  }
  if (commands.length > 0) return { ...base, verdict: "commands", manifests: [...commands, ...declaresNothing] };

  const code = walkForCode(root);
  if (code === "too-large") return unknown(`the tree holds more than ${MAX_ENTRIES} entries`, declaresNothing);
  if (code === "unreadable") return unknown("a directory under the root could not be read", declaresNothing);
  if (code.pyTest) {
    return { ...base, verdict: "commands", manifests: [...declaresNothing, `${code.pyTest}: a pytest test file`] };
  }
  if (code.other) return unknown(`${code.other} is source code of a project type with no manifest read here`, declaresNothing);
  if (code.js && !files.has("package.json")) return unknown(`${code.js} is JavaScript/TypeScript with no package.json`, declaresNothing);
  if (code.py && !PYTHON_MANIFESTS.some((name) => files.has(name))) {
    return unknown(`${code.py} is Python with no pyproject.toml, setup.cfg, setup.py, requirements.txt or Pipfile`, declaresNothing);
  }
  return { ...base, verdict: "none", manifests: declaresNothing };
}

function packageScripts(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (scripts === undefined) return {};
    return typeof scripts === "object" && scripts !== null && !Array.isArray(scripts) ? scripts as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

interface CodeFound {
  /** The first file of each kind, relative to the root. */
  js?: string;
  py?: string;
  pyTest?: string;
  other?: string;
}

function walkForCode(root: string): CodeFound | "too-large" | "unreadable" {
  const found: CodeFound = {};
  let seen = 0;
  const pending: Array<{ dir: string; rel: string }> = [{ dir: root, rel: "" }];
  while (pending.length > 0) {
    const { dir, rel } = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return "unreadable";
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return "too-large";
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) {
          pending.push({ dir: join(dir, entry.name), rel: relPath });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : "";
      if (JS_EXT.has(ext)) found.js ??= relPath;
      else if (PY_EXT.has(ext)) {
        found.py ??= relPath;
        if (PY_TEST_FILE_RE.test(entry.name)) found.pyTest ??= relPath;
      } else if (OTHER_CODE_EXT.has(ext)) found.other ??= relPath;
    }
  }
  return found;
}
